import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import { chromium } from "playwright";

export const cycleChecks = ["page_response", "page_title", "h1_heading", "image_alt", "mobile_viewport"];
const browserActions = new Set(["goto", "fill", "click", "expect_text", "expect_url", "expect_visible"]);
const assertions = new Set(["expect_text", "expect_url", "expect_visible"]);
const secretReference = /^\{\{env:(E2E_[A-Z0-9_]+)\}\}$/;

function targetUrl(value, baseUrl) {
  try {
    const target = new URL(value, baseUrl);
    if (target.origin !== new URL(baseUrl).origin || target.username || target.password) return null;
    normalizeWebsiteUrl(target.href);
    return target;
  } catch { return null; }
}

export function definitionError(testCase, websiteUrl) {
  if (testCase.automation_type !== "playwright") return "Not automated: this cycle runner requires automation type Playwright.";
  if (!Array.isArray(testCase.steps) || !testCase.steps.length) return "Not automated: provide at least one step.";
  if (testCase.steps.length > 25) return "Not automated: use at most 25 steps per case.";
  const hasBrowserActions = testCase.steps.some(step => browserActions.has(step?.action));
  if (hasBrowserActions && !testCase.steps.some(step => assertions.has(step?.action))) return "Not automated: browser cases need an expect_text, expect_url, or expect_visible assertion.";
  let navigated = !hasBrowserActions;
  for (const step of testCase.steps) {
    if (!step || typeof step !== "object" || Array.isArray(step)) return "Not automated: each step must be an action object.";
    if (step.action === "check") {
      if (!cycleChecks.includes(step.value) || Object.keys(step).some(key => !["action", "value"].includes(key))) return `Not automated: unsupported check. Use one of: ${cycleChecks.join(", ")}.`;
      if (hasBrowserActions && !navigated) return "Not automated: start browser cases with goto before checking the page.";
      continue;
    }
    if (!browserActions.has(step.action)) return "Not automated: unsupported Playwright action.";
    if (Object.keys(step).some(key => !["action", "selector", "value", "timeout"].includes(key))) return "Not automated: unsupported browser step field.";
    if (step.timeout !== undefined && (!Number.isInteger(step.timeout) || step.timeout < 1 || step.timeout > 30000)) return "Not automated: timeout must be 1 to 30000 milliseconds.";
    if (["fill", "click", "expect_visible"].includes(step.action) && (typeof step.selector !== "string" || !step.selector.trim() || step.selector.length > 500)) return "Not automated: this action needs a selector of at most 500 characters.";
    if (step.selector !== undefined && (typeof step.selector !== "string" || !step.selector.trim() || step.selector.length > 500)) return "Not automated: invalid selector.";
    if (["goto", "expect_url"].includes(step.action) && step.selector !== undefined) return "Not automated: navigation and URL assertions cannot have a selector.";
    if (["goto", "fill", "expect_text", "expect_url"].includes(step.action) && typeof step.value !== "string") return "Not automated: this action needs a text value.";
    if (step.action === "expect_text" && !step.value) return "Not automated: expect_text needs nonempty text.";
    if (["click", "expect_visible"].includes(step.action) && step.value !== undefined) return "Not automated: this action cannot have a value.";
    if (step.action === "goto" || step.action === "expect_url") {
      if (!step.value || !targetUrl(step.value, websiteUrl || "https://example.com")) return "Not automated: navigation must stay on the configured public website.";
    }
    if (step.action === "fill" && step.value && !secretReference.test(step.value)) return "Not automated: nonempty form values must use a named E2E_ runner secret.";
    if (step.action !== "fill" && String(step.value || "").includes("{{env:")) return "Not automated: runner secrets may only be used in fill steps.";
    if (!navigated && step.action !== "goto") return "Not automated: start browser cases with goto before interacting with the page.";
    if (step.action === "goto") navigated = true;
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

async function installPublicRouting(context, signal) {
  let requestCount = 0, navigationError = "", finalNavigationUrl = "", redirectedResponse;
  await context.routeWebSocket("**/*", socket => socket.close());
  await context.route("**/*", async route => {
    try {
      if (++requestCount > 100) throw new Error("Website exceeded the 100-request execution limit.");
      const request = route.request();
      const navigation = request.isNavigationRequest() && request.frame().parentFrame() === null;
      const response = navigation && redirectedResponse?.finalUrl === request.url() ? redirectedResponse : await publicRequest({
        url: request.url(), method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer(),
      }, signal);
      const { finalUrl, ...fulfillment } = response;
      if (navigation) {
        finalNavigationUrl = finalUrl;
        if (finalUrl !== request.url()) {
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
  return {
    navigationError: () => navigationError,
    async followRedirect(page) {
      if (navigationError) throw new Error(navigationError);
      let response = null;
      for (let count = 0; finalNavigationUrl && finalNavigationUrl !== page.url() && count < 8; count += 1) {
        response = await page.goto(finalNavigationUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      }
      if (navigationError) throw new Error(navigationError);
      return response;
    },
  };
}

async function runCase(browser, testCase, websiteUrl, signal, resolveSecret) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block", acceptDownloads: false });
  try {
    const routing = await installPublicRouting(context, signal);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const hasBrowserActions = testCase.steps.some(step => browserActions.has(step.action));
    const hasRunnerSecrets = testCase.steps.some(step => step.action === "fill" && secretReference.test(step.value));
    let response = null;
    if (!hasBrowserActions) {
      response = await page.goto(websiteUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(error => { throw new Error(routing.navigationError() || error.message); });
      response = await routing.followRedirect(page) || response;
      await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    }
    const failures = [];
    for (let index = 0; index < testCase.steps.length; index += 1) {
      const step = testCase.steps[index];
      if (step.action === "check") {
        if (routing.navigationError()) throw new Error("Browser navigation was blocked.");
        const checks = evaluateChecks({ ...await page.evaluate(inspectHomepage), status: response?.status() || 0 });
        if (!checks[step.value].passed) failures.push(hasRunnerSecrets ? `Website check ${step.value} failed.` : checks[step.value].detail);
        continue;
      }
      try {
        signal.throwIfAborted();
        const timeout = step.timeout || 10000;
        if (step.action === "goto") {
          response = await page.goto(targetUrl(step.value, websiteUrl).href, { waitUntil: "domcontentloaded", timeout: step.timeout || 30000 });
          response = await routing.followRedirect(page) || response;
        } else if (step.action === "fill") {
          if (new URL(page.url()).origin !== new URL(websiteUrl).origin) throw new Error("Form is outside the configured website.");
          const reference = secretReference.exec(step.value);
          const value = reference ? await resolveSecret?.(reference[1]) : "";
          if (reference && (typeof value !== "string" || !value)) throw new Error("Runner secret is unavailable.");
          await page.locator(step.selector).fill(value, { timeout });
        } else if (step.action === "click") {
          await page.locator(step.selector).click({ timeout });
          response = await routing.followRedirect(page) || response;
        } else if (step.action === "expect_text") {
          response = await routing.followRedirect(page) || response;
          await page.locator(step.selector || "body").filter({ hasText: step.value }).waitFor({ state: "visible", timeout });
        } else if (step.action === "expect_url") {
          response = await routing.followRedirect(page) || response;
          const expected = targetUrl(step.value, websiteUrl);
          const expectedPath = expected.pathname.replace(/\/$/, "") || "/";
          await page.waitForURL(url => url.origin === expected.origin && (url.pathname.replace(/\/$/, "") || "/") === expectedPath, { timeout: step.timeout || 30000 });
        } else if (step.action === "expect_visible") {
          response = await routing.followRedirect(page) || response;
          await page.locator(step.selector).waitFor({ state: "visible", timeout });
        }
      } catch {
        // Playwright errors can contain filled secrets and page data; never persist them.
        throw new Error(`Browser step ${index + 1} (${step.action}) failed. Check the target, selectors, and runner secrets.`);
      }
    }
    return { status: failures.length ? "failed" : "passed", error_message: failures.length ? failures.join(" ") : null };
  } finally { await context.close().catch(() => {}); }
}

export async function executeCycle(cases, websiteUrl, { resolveSecret } = {}) {
  const results = cases.map(testCase => ({ test_case_id: testCase.id, status: "skipped", duration_ms: 0, error_message: definitionError(testCase, websiteUrl), evidence: [] }));
  if (results.every(result => result.error_message)) return results;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error("Cycle execution timed out.")), Math.max(45000, cases.length * 45000));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, timeout: 15000, args: ["--disable-quic", "--disable-background-networking", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] });
    controller.signal.addEventListener("abort", () => { void browser.close().catch(() => {}); }, { once: true });
    for (const result of results) {
      if (result.error_message) continue;
      const testCase = cases.find(item => item.id === result.test_case_id);
      const started = Date.now();
      try {
        const outcome = await runCase(browser, testCase, websiteUrl, controller.signal, resolveSecret);
        Object.assign(result, outcome);
      } catch (error) {
        result.status = "failed";
        const hasBrowserActions = testCase.steps.some(step => browserActions.has(step.action));
        result.error_message = controller.signal.aborted ? "Cycle execution timed out." : hasBrowserActions
          ? /^Browser step \d+ \([a-z_]+\) failed\./.test(error.message) ? error.message : "Browser execution failed. Check the target and runner configuration."
          : error.message;
      }
      result.duration_ms = Date.now() - started;
    }
  } catch (error) {
    for (const result of results.filter(item => item.status === "skipped" && !item.error_message)) {
      result.status = "failed";
      result.error_message = controller.signal.aborted ? "Cycle execution timed out." : "Browser could not start.";
    }
  } finally {
    clearTimeout(deadline);
    await browser?.close().catch(() => {});
  }
  return results;
}
