import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { cycleChecks, definitionError, evaluateChecks, executeCycle, inspectHomepage, isPublicAddress, normalizeWebsiteUrl, resolvePublicTarget } from "../lib/cycle-runner.mjs";

test("cycle definitions accept only explicit supported checks", () => {
  assert.equal(definitionError({ automation_type: "playwright", steps: cycleChecks.map(value => ({ action: "check", value })) }), null);
  for (const steps of [[], null, [{ action: "goto", value: "/" }], [{ action: "check", value: "unknown" }], [{ action: "check", value: "page_title", selector: "body" }]]) {
    assert.match(definitionError({ automation_type: "playwright", steps }), /Not automated/);
  }
  assert.match(definitionError({ automation_type: "manual", steps: [{ action: "check", value: "page_title" }] }), /Playwright/);
});

test("browser definitions validate actions, selectors, targets, secrets, and limits", () => {
  const steps = [
    { action: "goto", value: "/login" },
    { action: "fill", selector: "#email", value: "{{env:E2E_EMAIL}}" },
    { action: "fill", selector: "#password", value: "{{env:E2E_PASSWORD}}" },
    { action: "click", selector: "#sign-in" },
    { action: "expect_text", selector: "#state", value: "Signed in" },
    { action: "expect_url", value: "/login" },
    { action: "expect_visible", selector: "#logout" },
  ];
  const error = candidate => definitionError({ automation_type: "playwright", steps: candidate }, "https://8.8.8.8/");
  assert.equal(error(steps), null);
  assert.match(error([{ action: "goto", value: "/login" }]), /assertion/);
  assert.match(error([{ action: "goto", value: "http:\/\/127.0.0.1\/" }, steps[4]]), /public website/);
  assert.match(error([{ action: "goto", value: "https:\/\/other.example\/" }, steps[4]]), /public website/);
  assert.match(error([{ action: "goto", value: "/login" }, { action: "click", selector: "" }, steps[4]]), /selector/);
  assert.match(error([{ action: "goto", value: "/login" }, { action: "expect_text", value: "" }]), /nonempty/);
  assert.match(error([{ action: "goto", value: "/login" }, { action: "fill", selector: "#password", value: "literal-password" }, steps[4]]), /runner secret/);
  assert.match(error([{ action: "goto", value: "/login" }, { action: "fill", selector: "#password", value: "{{env:OTHER}}" }, steps[4]]), /runner secret/);
  assert.match(error([{ action: "goto", value: "/login" }, { action: "click", selector: "#sign-in", timeout: 50000 }, steps[4]]), /timeout/);
  assert.match(error([{ action: "goto", value: "/login", unexpected: true }, steps[4]]), /field/);
  assert.match(error([{ action: "goto", value: "/login" }, { action: "wait", value: "500" }, steps[4]]), /unsupported/);
  assert.match(error(Array.from({ length: 26 }, () => ({ action: "check", value: "page_title" }))), /25/);
});

test("GitHub Actions forwards every login secret name used by the cycle runner", () => {
  const workflow = readFileSync(new URL("../.github/workflows/automation.yml", import.meta.url), "utf8");
  for (const name of ["E2E_EMAIL", "E2E_PASSWORD", "E2E_LOGIN_USER", "E2E_LOGIN_PASSWORD", "E2E_INVALID_PASSWORD", "E2E_UNREGISTERED_USER"]) {
    assert.ok(workflow.includes(name + ": ${{ secrets." + name + " }}"), `${name} is not forwarded to Node`);
    const steps = [{ action: "goto", value: "/login" }, { action: "fill", selector: "#field", value: `{{env:${name}}}` }, { action: "expect_visible", selector: "#field" }];
    assert.equal(definitionError({ automation_type: "playwright", steps }, "https://8.8.8.8"), null);
  }
});

test("unsupported cases are skipped without attempting browser execution", async () => {
  const results = await executeCycle([
    { id: "manual", automation_type: "manual", steps: [] },
    { id: "empty", automation_type: "playwright", steps: [] },
    { id: "legacy", automation_type: "playwright", steps: [{ action: "goto", value: "/" }] },
  ], "https://example.com");
  assert.equal(results.length, 3);
  assert.ok(results.every(result => result.status === "skipped" && result.error_message && result.duration_ms === 0));
});

test("public URL normalization rejects credentials, internal hosts and encoded IPs", () => {
  assert.equal(normalizeWebsiteUrl(" https://example.com/path#section "), "https://example.com/path");
  assert.equal(normalizeWebsiteUrl("http://example.com"), "http://example.com/");
  for (const url of ["file:///etc/passwd", "ftp://example.com", "https://user:pass@example.com", "http://localhost", "http://localhost.", "http://internal", "http://host.local", "http://host.internal", "http://127.0.0.1", "http://2130706433", "http://0x7f000001", "http://[::1]", "http://[::ffff:127.0.0.1]", "http://169.254.169.254", "http://10.0.0.1", "http://192.168.1.1", "not a url"]) {
    assert.throws(() => normalizeWebsiteUrl(url), undefined, url);
  }
});

test("private, reserved, mapped and transition addresses are blocked", () => {
  for (const ip of ["0.0.0.0", "10.1.1.1", "127.0.0.1", "100.64.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::1", "::ffff:8.8.8.8", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::", "3fff::1"]) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
});

test("DNS validation rejects mixed public/private answers and pins a public answer", async () => {
  await assert.rejects(resolvePublicTarget("https://example.com", async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]), /private/);
  await assert.rejects(resolvePublicTarget("https://example.com", async () => []), /private/);
  const target = await resolvePublicTarget("https://example.com", async () => [{ address: "8.8.8.8", family: 4 }]);
  assert.deepEqual(target.address, { address: "8.8.8.8", family: 4 });
});

test("check outcomes distinguish failures and enforce exact H1 and viewport semantics", () => {
  const info = { status: 200, title: "Example", h1Count: 1, headings: ["Example"], missingAlt: 0, viewport: "width=device-width, initial-scale=1" };
  assert.ok(Object.values(evaluateChecks(info)).every(check => check.passed));
  const failures = evaluateChecks({ status: 404, title: "", h1Count: 2, headings: ["One"], missingAlt: 2, viewport: "width=1200" });
  assert.ok(Object.values(failures).every(check => !check.passed && check.detail));
  assert.equal(evaluateChecks({ ...info, status: 302 }).page_response.passed, true);
  assert.equal(evaluateChecks({ ...info, status: 0 }).page_response.passed, false);
  assert.equal(evaluateChecks({ ...info, viewport: "width=device-width-wrong" }).mobile_viewport.passed, false);
});

test("real Chromium inspects DOM, including decorative images and empty extra H1s", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<title>Good page</title><meta name="viewport" content="width=device-width, initial-scale=1"><h1>Welcome</h1><img alt="A mountain"><img alt="" role="presentation"><img alt="" role="none">');
    const good = await page.evaluate(inspectHomepage);
    assert.ok(Object.values(evaluateChecks({ ...good, status: 200 })).every(check => check.passed));
    await page.setContent('<title> </title><h1>Welcome</h1><h1> </h1><img><img alt=""><img alt="   "><img role="presentation">');
    const bad = await page.evaluate(inspectHomepage);
    assert.equal(bad.missingAlt, 4);
    assert.equal(bad.h1Count, 2);
    const checks = evaluateChecks({ ...bad, status: 500 });
    assert.ok(Object.values(checks).every(check => !check.passed));
  } finally { await browser.close(); }
});

test("real cycle execution blocks internal navigation and never passes unexecuted cases", async () => {
  const results = await executeCycle([
    { id: "supported", automation_type: "playwright", steps: [{ action: "check", value: "page_title" }] },
    { id: "unsupported", automation_type: "playwright", steps: [{ action: "check", value: "unknown" }] },
  ], "http://127.0.0.1:9");
  assert.equal(results[0].status, "failed");
  assert.match(results[0].error_message, /private|internal/);
  assert.equal(results[1].status, "skipped");
});

async function withWebsiteFixture(response, run) {
  const original = https.request;
  let requests = 0;
  https.request = (url, options, callback) => {
    requests++;
    assert.equal(url.hostname, "8.8.8.8");
    const outgoing = new EventEmitter();
    outgoing.setTimeout = () => outgoing;
    outgoing.destroy = error => outgoing.emit("error", error);
    outgoing.end = body => queueMicrotask(() => {
      const fixture = typeof response === "function" ? response(url, options, body) : response;
      const incoming = Readable.from([Buffer.from(fixture.body || "")]);
      incoming.statusCode = fixture.status;
      incoming.headers = { "content-type": "text/html", ...fixture.headers };
      callback(incoming);
    });
    return outgoing;
  };
  try { await run(() => requests); }
  finally { https.request = original; }
}

test("full Chromium cycle executes only assigned definitions and aggregates multiple checks", async () => {
  await withWebsiteFixture({ status: 200, body: '<title>Fixture</title><h1>One heading</h1><link rel="icon" href="data:,">' }, async requests => {
    const results = await executeCycle([
      { id: "pass", automation_type: "playwright", steps: [{ action: "check", value: "page_response" }, { action: "check", value: "h1_heading" }] },
      { id: "fail", automation_type: "playwright", steps: [{ action: "check", value: "page_title" }, { action: "check", value: "mobile_viewport" }] },
      { id: "manual", automation_type: "manual", steps: [] },
    ], "https://8.8.8.8");
    assert.deepEqual(results.map(result => [result.test_case_id, result.status]), [["pass", "passed"], ["fail", "failed"], ["manual", "skipped"]]);
    assert.match(results[1].error_message, /viewport/);
    assert.equal(requests(), 2);
  });
});

test("login redirects carry updated session cookies to assertions and logout", async () => {
  const user = crypto.randomUUID(), password = crypto.randomUUID();
  const paths = [];
  await withWebsiteFixture((url, options, body) => {
    paths.push(url.pathname);
    const cookie = options.headers.cookie || "";
    if (url.pathname === "/login") return { status: 200, headers: cookie ? {} : { "set-cookie": "rack.session=before; Path=/" }, body: `<form action="/authenticate" method="post"><input name="username" id="username"><input name="password" id="password"><button id="sign-in">Sign In</button></form>${cookie.includes("rack.session=error") ? '<div id="flash">Your password is invalid!</div>' : cookie.includes("rack.session=loggedout") ? '<div id="flash">You logged out!</div>' : ""}` };
    if (url.pathname === "/authenticate") {
      const fields = new URLSearchParams(body.toString());
      const valid = fields.get("username") === user && fields.get("password") === password;
      return { status: 302, headers: { location: valid ? "/secure" : "/login", "set-cookie": `rack.session=${valid ? "authenticated" : "error"}; Path=/` } };
    }
    if (url.pathname === "/secure") return cookie.includes("rack.session=authenticated") ? { status: 200, body: '<a id="logout" href="/logout">Log Out</a>' } : { status: 302, headers: { location: "/login" } };
    if (url.pathname === "/logout") return { status: 302, headers: { location: "/login", "set-cookie": "rack.session=loggedout; Path=/" } };
    return { status: 404, body: "Not found" };
  }, async () => {
    const results = await executeCycle([
      { id: "valid", automation_type: "playwright", steps: [
        { action: "goto", value: "/login" }, { action: "fill", selector: "#username", value: "{{env:E2E_LOGIN_USER}}" }, { action: "fill", selector: "#password", value: "{{env:E2E_LOGIN_PASSWORD}}" },
        { action: "click", selector: "#sign-in" }, { action: "expect_visible", selector: "#logout" }, { action: "expect_url", value: "/secure" },
        { action: "click", selector: "#logout" }, { action: "expect_url", value: "/login" }, { action: "expect_text", selector: "#flash", value: "You logged out!" },
      ] },
      { id: "invalid", automation_type: "playwright", steps: [
        { action: "goto", value: "/login" }, { action: "fill", selector: "#username", value: "{{env:E2E_LOGIN_USER}}" }, { action: "fill", selector: "#password", value: "{{env:E2E_INVALID_PASSWORD}}" },
        { action: "click", selector: "#sign-in" }, { action: "expect_text", selector: "#flash", value: "Your password is invalid!" },
      ] },
    ], "https://8.8.8.8", { resolveSecret: name => ({ E2E_LOGIN_USER: user, E2E_LOGIN_PASSWORD: password, E2E_INVALID_PASSWORD: crypto.randomUUID() })[name] });
    assert.deepEqual(results.map(result => result.status), ["passed", "passed"], JSON.stringify(results));
    assert.ok(paths.includes("/secure") && paths.includes("/logout"));
    assert.ok(!JSON.stringify(results).includes(password));
  });
});

test("local login fixture isolates cases and supports login plus logout actions", async () => {
  const secret = crypto.randomUUID();
  const html = `<title>Local login fixture</title><form id="login"><input id="email"><input id="password" type="password"><button id="sign-in">Sign In</button></form><button id="logout" type="button">Log Out</button><div id="state"></div><script>
    const state=document.querySelector('#state');
    state.textContent=localStorage.getItem('authenticated')?'Signed in':'Signed out';
    document.querySelector('#login').onsubmit=event=>{event.preventDefault();if(document.querySelector('#email').value&&document.querySelector('#password').value){localStorage.setItem('authenticated','yes');state.textContent='Signed in'}};
    document.querySelector('#logout').onclick=()=>{localStorage.removeItem('authenticated');state.textContent='Signed out'};
  </script>`;
  const signIn = [
    { action: "goto", value: "/login" },
    { action: "fill", selector: "#email", value: "{{env:E2E_EMAIL}}" },
    { action: "fill", selector: "#password", value: "{{env:E2E_PASSWORD}}" },
    { action: "click", selector: "#sign-in" },
    { action: "expect_text", selector: "#state", value: "Signed in" },
  ];
  await withWebsiteFixture({ status: 200, body: html }, async () => {
    const results = await executeCycle([
      { id: "sign-in", automation_type: "playwright", steps: signIn },
      { id: "isolated", automation_type: "playwright", steps: [{ action: "goto", value: "/login" }, { action: "expect_text", selector: "#state", value: "Signed out" }] },
      { id: "logout", automation_type: "playwright", steps: [...signIn, { action: "click", selector: "#logout" }, { action: "expect_text", selector: "#state", value: "Signed out" }] },
    ], "https://8.8.8.8", { resolveSecret: name => ({ E2E_EMAIL: "fixture@example.com", E2E_PASSWORD: secret })[name] });
    assert.deepEqual(results.map(result => result.status), ["passed", "passed", "passed"], JSON.stringify(results));
    assert.ok(results.every(result => result.evidence.length === 0));
    assert.ok(!JSON.stringify(results).includes(secret));
  });
});

test("cycle runner resolves all four new login references without persisting values", async () => {
  const names = ["E2E_LOGIN_USER", "E2E_LOGIN_PASSWORD", "E2E_INVALID_PASSWORD", "E2E_UNREGISTERED_USER"];
  const values = Object.fromEntries(names.map(name => [name, crypto.randomUUID()]));
  const html = '<form id="login"><input id="user"><input id="password"><input id="invalid"><input id="unregistered"><button id="submit">Submit</button></form><div id="state"></div><script>document.querySelector("#login").onsubmit=e=>{e.preventDefault();document.querySelector("#state").textContent=["#user","#password","#invalid","#unregistered"].every(s=>document.querySelector(s).value)?"Ready":"Missing"}</script>';
  await withWebsiteFixture({ status: 200, body: html }, async () => {
    const steps = [{ action: "goto", value: "/login" },
      ...names.map((name, index) => ({ action: "fill", selector: ["#user", "#password", "#invalid", "#unregistered"][index], value: `{{env:${name}}}` })),
      { action: "click", selector: "#submit" }, { action: "expect_text", selector: "#state", value: "Ready" }];
    const [result] = await executeCycle([{ id: "named-secrets", automation_type: "playwright", steps }], "https://8.8.8.8", { resolveSecret: name => values[name] });
    assert.equal(result.status, "passed", result.error_message);
    assert.deepEqual(result.evidence, []);
    for (const value of Object.values(values)) assert.ok(!JSON.stringify(result).includes(value));
  });
});

test("action navigation to private destinations is rejected without connecting", async () => {
  await withWebsiteFixture({ status: 200, body: '<a id="private" href="http://127.0.0.1:8088/">Private</a>' }, async requests => {
    const results = await executeCycle([{ id: "private", automation_type: "playwright", steps: [
      { action: "goto", value: "/login" }, { action: "click", selector: "#private" }, { action: "expect_visible", selector: "body" },
    ] }], "https://8.8.8.8");
    assert.equal(results[0].status, "failed");
    assert.match(results[0].error_message, /Browser step/);
    assert.equal(requests(), 1);
  });
});

test("browser actions follow a public form redirect and verify the final URL", async () => {
  const paths = [];
  await withWebsiteFixture(url => {
    paths.push(url.pathname);
    if (url.pathname === "/login") return { status: 200, body: '<form action="/session" method="post"><button id="sign-in">Sign In</button></form>' };
    if (url.pathname === "/session") return { status: 302, headers: { location: "/dashboard" } };
    return { status: 200, body: '<title>Dashboard</title><div id="account">Signed in</div>' };
  }, async () => {
    const [result] = await executeCycle([{ id: "redirect-login", automation_type: "playwright", steps: [
      { action: "goto", value: "/login" }, { action: "click", selector: "#sign-in" },
      { action: "expect_url", value: "/dashboard" }, { action: "expect_visible", selector: "#account" },
    ] }], "https://8.8.8.8");
    assert.equal(result.status, "passed", result.error_message);
    assert.deepEqual(paths, ["/login", "/session", "/dashboard"]);
  });
});

test("missing secrets and Playwright errors are redacted from results", async () => {
  const secret = crypto.randomUUID();
  await withWebsiteFixture({ status: 200, body: '<input id="password" type="password">' }, async () => {
    const steps = [{ action: "goto", value: "/login" }, { action: "fill", selector: "#password", value: "{{env:E2E_PASSWORD}}" }, { action: "click", selector: "#missing", timeout: 200 }, { action: "expect_visible", selector: "body" }];
    const [failed] = await executeCycle([{ id: "failed", automation_type: "playwright", steps }], "https://8.8.8.8", { resolveSecret: name => name === "E2E_PASSWORD" ? secret : undefined });
    const [unavailable] = await executeCycle([{ id: "unavailable", automation_type: "playwright", steps }], "https://8.8.8.8");
    assert.equal(failed.status, "failed");
    assert.equal(unavailable.status, "failed");
    assert.ok(!JSON.stringify([failed, unavailable]).includes(secret));
    assert.deepEqual(failed.evidence, []);
  });
});

test("Chromium redirects to private destinations are revalidated before transport", async () => {
  await withWebsiteFixture({ status: 302, headers: { location: "http://127.0.0.1:8088" } }, async requests => {
    const results = await executeCycle([{ id: "redirect", automation_type: "playwright", steps: [{ action: "check", value: "page_response" }] }], "https://8.8.8.8");
    assert.equal(results[0].status, "failed");
    assert.match(results[0].error_message, /private|internal/);
    assert.equal(requests(), 1);
  });
});

test("public redirects retain the final document URL for relative resources", async () => {
  const paths = [];
  await withWebsiteFixture(url => {
    paths.push(url.pathname);
    if (url.pathname === "/") return { status: 302, headers: { location: "/landing/" } };
    if (url.pathname === "/landing/") return { status: 200, body: '<title>Redirected</title><link rel="icon" href="data:,"><body><script src="marker.js"></script></body>' };
    return { status: 200, headers: { "content-type": "text/javascript" }, body: 'document.body.appendChild(document.createElement("h1")).textContent="Loaded";' };
  }, async requests => {
    const results = await executeCycle([{ id: "redirect", automation_type: "playwright", steps: [{ action: "check", value: "h1_heading" }] }], "https://8.8.8.8");
    assert.equal(results[0].status, "passed", results[0].error_message);
    assert.deepEqual(paths, ["/", "/landing/", "/landing/marker.js"]);
    assert.equal(requests(), 3);
  });
});
