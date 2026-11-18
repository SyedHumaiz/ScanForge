import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { decryptLoginConfig, encryptLoginConfig, loginSecretValues, requiredLoginFields, validateLoginConfig } from "../lib/run-login-config.mjs";

const key = randomBytes(32).toString("base64");
const context = { runId: "run-one", projectId: "project-one", expiresAt: new Date(Date.now() + 60_000).toISOString() };
const cases = [{ automation_type: "playwright", steps: ["E2E_EMAIL", "E2E_LOGIN_PASSWORD", "E2E_UNREGISTERED_USER", "E2E_INVALID_PASSWORD"].map(name => ({ action: "fill", value: `{{env:${name}}}` })) }];
const config = { validUsername: "valid@example.com", validPassword: "valid-secret", invalidUsername: "missing@example.com", invalidPassword: "invalid-secret" };

test("required fields are derived from assigned fill references; health cases need none", () => {
  assert.deepEqual(requiredLoginFields([{ steps: [{ action: "check", value: "page_title" }] }]).fields, []);
  assert.deepEqual(requiredLoginFields(cases).fields, ["validUsername", "validPassword", "invalidUsername", "invalidPassword"]);
  assert.deepEqual(requiredLoginFields([{ ...cases[0], automation_type: "manual" }]).fields, []);
  assert.throws(() => validateLoginConfig(cases, { validUsername: "ok" }), /Valid password/);
  assert.deepEqual(validateLoginConfig([{ steps: [{ action: "check", value: "page_title" }] }], config), {});
  assert.equal(loginSecretValues(config).E2E_LOGIN_USER, config.validUsername);
  assert.equal(loginSecretValues(config).E2E_PASSWORD, config.validPassword);
});

test("AES-GCM payloads are distinct and bound to the run, project, and expiry", () => {
  const encrypted = encryptLoginConfig(config, context, key);
  assert.equal(encrypted.includes(config.validPassword), false);
  assert.notEqual(encrypted, encryptLoginConfig(config, context, key));
  assert.deepEqual(decryptLoginConfig(encrypted, context, key), config);
  const databaseTimestamp = context.expiresAt.replace("Z", "+00:00");
  assert.deepEqual(decryptLoginConfig(encrypted, { ...context, expiresAt: databaseTimestamp }, key), config);
  const wholeSecond = { ...context, expiresAt: "2030-01-01T00:00:00.000Z" };
  const wholeSecondPayload = encryptLoginConfig(config, wholeSecond, key);
  assert.deepEqual(decryptLoginConfig(wholeSecondPayload, { ...wholeSecond, expiresAt: "2030-01-01T00:00:00+00:00" }, key), config);
  for (const altered of [{ ...context, runId: "run-two" }, { ...context, projectId: "project-two" }, { ...context, expiresAt: new Date(Date.now() + 90_000).toISOString() }]) {
    assert.throws(() => decryptLoginConfig(encrypted, altered, key));
  }
  assert.throws(() => decryptLoginConfig(encrypted, context, key, Date.parse(context.expiresAt)), /expired/);
  assert.throws(() => decryptLoginConfig(encrypted, context, randomBytes(32).toString("base64")));
});

test("different runs resolve only their own values", () => {
  const other = { ...config, validPassword: "another-run-secret" };
  const second = { ...context, runId: "run-two" };
  const firstPayload = encryptLoginConfig(config, context, key);
  const secondPayload = encryptLoginConfig(other, second, key);
  assert.equal(loginSecretValues(decryptLoginConfig(firstPayload, context, key)).E2E_PASSWORD, config.validPassword);
  assert.equal(loginSecretValues(decryptLoginConfig(secondPayload, second, key)).E2E_PASSWORD, other.validPassword);
  assert.throws(() => decryptLoginConfig(firstPayload, second, key));
});

test("workflow dispatch includes only identifiers and reports do not read ciphertext", () => {
  const workflow = readFileSync(new URL("../.github/workflows/automation.yml", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/api/cycles/run/route.js", import.meta.url), "utf8");
  const runner = readFileSync(new URL("../automation/runner.mjs", import.meta.url), "utf8");
  const report = readFileSync(new URL("../lib/cycle-report.mjs", import.meta.url), "utf8");
  assert.match(route, /inputs: \{ run_id: run\.id, project_id: body\.projectId, test_case_ids: ids\.join\(","\), source: "cycle" \}/);
  assert.doesNotMatch(workflow, /inputs:[\s\S]*?loginConfig/);
  assert.doesNotMatch(report, /ciphertext|loginConfig|validPassword|invalidPassword/);
  assert.match(runner, /uses_run_login_config:run\.summary\?\.uses_run_login_config/);
  assert.match(runner, /Cycle runner failed \(\$\{failureCode\}\)/);
});
