import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import { chromium } from "playwright";

export const cycleChecks = ["page_response", "page_title", "h1_heading", "image_alt", "mobile_viewport"];

export function definitionError(testCase) {
  if (testCase.automation_type !== "playwright") return "Not automated: this cycle runner requires automation type Playwright.";
  if (!Array.isArray(testCase.steps) || !testCase.steps.length) return "Not automated: provide at least one check.";
  if (testCase.steps.length > 25) return "Not automated: use at most 25 checks per case.";
  for (const step of testCase.steps) {
    if (!step || step.action !== "check" || !cycleChecks.includes(step.value) || Object.keys(step).some(key => !["action", "value"].includes(key))) {
      return `Not automated: unsupported definition. Use action "check" with one of: ${cycleChecks.join(", ")}.`;
    }
  }
  return null;
}

export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 2) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  // Only global unicast IPv6; exclude transition, documentation and special-use ranges.
  if (isIP(address) === 6) {
    const parts = address.toLowerCase().split(":");
    const first = parseInt(parts[0], 16), second = parseInt(parts[1] || "0", 16);
    return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 &&
      !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) &&
      !(first === 0x3fff && second < 0x1000);
  }
  return false;
}

export function normalizeWebsiteUrl(value) {
  let url;
  try { url = new URL(typeof value === "string" ? value.trim() : ""); }
  catch { throw new Error("Enter a valid public HTTP or HTTPS website URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Use a public HTTP or HTTPS URL without credentials.");
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (isIP(host) ? !isPublicAddress(host) : (!host.includes(".") || /\.(localhost|local|internal|lan|home|test|invalid|onion|arpa)$/.test(host))) {
    throw new Error("Local, private and internal website addresses are not allowed.");
  }
  url.hash = "";
  return url.href;
}

export async function resolvePublicTarget(value, resolver = lookup) {
  const url = new URL(normalizeWebsiteUrl(value));
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let timer;
  try {
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([
      resolver(host, { all: true, verbatim: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Website DNS lookup timed out.")), 10000); }),
    ]);
    if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error("Website resolves to a private, internal or reserved address.");
    return { url, address: addresses.find(item => item.family === 4) || addresses[0] };
  } finally { clearTimeout(timer); }
}

// Fulfil browser requests through pinned DNS answers, following each redirect
// here because Playwright routing only intercepts the first URL of a redirect.
async function publicRequest(request, signal, redirects = 0) {
  if (redirects > 8) throw new Error("Website exceeded the eight-redirect execution limit.");
  const { url, address } = await resolvePublicTarget(request.url);
  signal.throwIfAborted();
  const headers = { ...request.headers, "accept-encoding": "identity" };
  delete headers.host;
  delete headers.connection;
  const response = await new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const outgoing = transport.request(url, {
      method: request.method, headers, signal, agent: false,
      lookup: (_hostname, options, callback) => options.all
        ? callback(null, [address]) : callback(null, address.address, address.family),
    }, response => {
      const chunks = [];
      let bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) outgoing.destroy(new Error("Website resource exceeds the 8 MB execution limit."));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        const responseHeaders = Object.fromEntries(Object.entries(response.headers)
          .filter(([key, value]) => value !== undefined && !["transfer-encoding", "connection", "content-length"].includes(key))
          .map(([key, value]) => [key, Array.isArray(value) ? value.join("\n") : String(value)]));
        resolve({ status: response.statusCode, headers: responseHeaders, body: Buffer.concat(chunks) });
      });
    });
    outgoing.setTimeout(10000, () => outgoing.destroy(new Error("Website request timed out.")));
    outgoing.on("error", reject);
    outgoing.end(request.body || undefined);
  });
  if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
    const destination = new URL(response.headers.location, url);
    if (destination.origin !== url.origin) {
      delete headers.cookie;
      delete headers.authorization;
    }
    const useGet = response.status === 303 || ([301, 302].includes(response.status) && request.method === "POST");
    if (useGet) { delete headers["content-type"]; delete headers["content-length"]; }
    return publicRequest({ url: destination.href, headers, method: useGet ? "GET" : request.method, body: useGet ? null : request.body }, signal, redirects + 1);
  }
  return { ...response, finalUrl: url.href };
}

export function evaluateChecks(info) {
  return {
    page_response: { passed: info.status >= 200 && info.status < 400, detail: `Homepage returned HTTP ${info.status}.` },
    page_title: { passed: !!info.title, detail: info.title ? `Title: ${info.title}` : "Homepage has no nonempty document title." },
    h1_heading: { passed: info.h1Count === 1 && info.headings.length === 1, detail: `Found ${info.h1Count} H1 element(s), ${info.headings.length} with nonempty text; expected exactly one nonempty H1.` },
    image_alt: { passed: info.missingAlt === 0, detail: info.missingAlt ? `${info.missingAlt} image(s) lack nonempty alt text. Decorative images require alt="" and role="presentation" or role="none".` : "Images have nonempty alt text or explicit decorative markup." },
    mobile_viewport: { passed: /(?:^|,)\s*width\s*=\s*device-width\s*(?:,|$)/i.test(info.viewport), detail: info.viewport || "No mobile viewport meta tag found; expected width=device-width." },
  };
}

// Runs inside the browser; kept separate so the real DOM rules can be tested.
export function inspectHomepage() {
  return {
    title: document.title.trim(),
    h1Count: document.querySelectorAll("h1").length,
    headings: [...document.querySelectorAll("h1")].map(node => node.innerText.trim()).filter(Boolean),
    missingAlt: [...document.images].filter(image => {
      const alt = image.getAttribute("alt");
      const decorative = alt === "" && ["presentation", "none"].includes((image.getAttribute("role") || "").toLowerCase());
      return !decorative && !alt?.trim();
    }).length,
    viewport: document.querySelector('meta[name="viewport"]')?.content || "",
  };
}

export async function executeCycle(cases, websiteUrl) {
  const results = cases.map(testCase => ({ test_case_id: testCase.id, status: "skipped", duration_ms: 0, error_message: definitionError(testCase), evidence: [] }));
  const executable = results.filter(result => !result.error_message);
  if (!executable.length) return results;
  const started = Date.now();
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error("Cycle execution exceeded 45 seconds.")), 45000);
  let browser;
  let context;
  let abortBrowser;
  try {
    browser = await chromium.launch({ headless: true, timeout: 15000, args: ["--disable-quic", "--disable-background-networking", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] });
    abortBrowser = () => { void browser.close().catch(() => {}); };
    controller.signal.addEventListener("abort", abortBrowser, { once: true });
    controller.signal.throwIfAborted();
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block", acceptDownloads: false });
    let requestCount = 0;
    let navigationError = "";
    let finalNavigationUrl = websiteUrl;
    let redirectedResponse;
    await context.routeWebSocket("**/*", socket => socket.close());
    await context.route("**/*", async route => {
      try {
        if (++requestCount > 100) throw new Error("Website exceeded the 100-request execution limit.");
        const request = route.request();
        const navigation = request.isNavigationRequest() && request.frame().parentFrame() === null;
        const response = navigation && redirectedResponse?.finalUrl === request.url() ? redirectedResponse : await publicRequest({
          url: request.url(), method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer(),
        }, controller.signal);
        const { finalUrl, ...fulfillment } = response;
        if (navigation) {
          finalNavigationUrl = finalUrl;
          if (finalUrl !== request.url()) {
            // Navigate explicitly to retain the final document URL and resolve
            // relative assets correctly, without a browser-followed redirect.
            redirectedResponse = response;
            await route.fulfill({ status: 200, contentType: "text/html", body: "" });
            return;
          }
          redirectedResponse = null;
        }
        await route.fulfill(fulfillment);
      } catch (error) {
        if (route.request().isNavigationRequest()) navigationError = error.message;
        await route.abort("blockedbyclient").catch(() => {});
      }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    let response = await page.goto(websiteUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(error => { throw new Error(navigationError || error.message); });
    if (finalNavigationUrl !== page.url()) {
      response = await page.goto(finalNavigationUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(error => { throw new Error(navigationError || error.message); });
    }
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    const info = await page.evaluate(inspectHomepage);
    controller.signal.throwIfAborted();
    const checks = evaluateChecks({ ...info, status: response?.status() || 0 });
    for (const result of executable) {
      const testCase = cases.find(item => item.id === result.test_case_id);
      const failures = testCase.steps.map(step => checks[step.value]).filter(check => !check.passed);
      result.status = failures.length ? "failed" : "passed";
      result.error_message = failures.length ? failures.map(check => check.detail).join(" ") : null;
      result.duration_ms = Date.now() - started;
    }
  } catch (error) {
    for (const result of executable) {
      result.status = "failed";
      result.error_message = controller.signal.aborted ? "Cycle execution exceeded 45 seconds." : error.message;
      result.duration_ms = Date.now() - started;
    }
  } finally {
    clearTimeout(deadline);
    if (abortBrowser) controller.signal.removeEventListener("abort", abortBrowser);
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
  return results;
}
