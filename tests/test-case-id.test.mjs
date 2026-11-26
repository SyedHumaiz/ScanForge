import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildRecordPayload } from "../lib/record-payload.mjs";
import { resolveNewTestCaseId, testCaseWriteError, validateTestCaseId } from "../lib/test-case-id.mjs";
import { buildCycleReportPdf } from "../lib/cycle-report.mjs";

const form = (key) => ({ key, title: "Sign in", steps: "[]" });

test("creating a case with TC-001 normalizes the visible ID", () => {
  const payload = buildRecordPayload("test-cases", form("  tc-001  "), "project-1");
  assert.equal(payload.key, "TC-001");
  assert.equal(resolveNewTestCaseId(payload.key, () => "TC-FALLBACK"), "TC-001");
  assert.equal(validateTestCaseId(" tc - login - 01 "), "TC-LOGIN-01");
});

test("editing a random ID to TC-002 retains the same database record identity", () => {
  const existing = { id: "same-uuid", project_id: "project-1", key: "TC-87E1C3EF", title: "Sign in" };
  const payload = buildRecordPayload("test-cases", form("tc-002"), existing.project_id, { editing: true });
  const updated = { ...existing, key: payload.key };
  assert.equal(updated.id, existing.id);
  assert.equal(updated.key, "TC-002");
  assert.throws(() => buildRecordPayload("test-cases", form(" "), existing.project_id, { editing: true }), /Enter a Test Case ID/);
});

test("duplicate IDs in a project produce a clear conflict", () => {
  const issue = testCaseWriteError({ code: "23505", message: "duplicate key value violates unique constraint" });
  assert.equal(issue.status, 409);
  assert.match(issue.message, /already exists in this project/);
  assert.match(readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8"), /create table if not exists public\.test_cases[\s\S]*?unique\(project_id,key\)/);
});

test("blank new IDs use automatic generation", () => {
  const payload = buildRecordPayload("test-cases", form("  "), "project-1");
  assert.equal(payload.key, "");
  assert.equal(resolveNewTestCaseId(payload.key, () => "TC-87E1C3EF"), "TC-87E1C3EF");
  assert.throws(() => validateTestCaseId("REQ-001"), /must start with TC-/);
});

test("cycle and execution records remain UUID linked after an ID change", () => {
  const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
  assert.match(schema, /test_case_id uuid not null references public\.test_cases\(id\)[\s\S]*?primary key\(cycle_id,test_case_id\)/);
  assert.match(schema, /test_case_id uuid references public\.test_cases\(id\)/);
  const source = readFileSync(new URL("../app/api/data/[resource]/[id]/route.js", import.meta.url), "utf8");
  assert.match(source, /\.update\(updates\)\.eq\("id", id\)\.eq\("project_id", body\.project_id\)/);
  const pdf = Buffer.from(buildCycleReportPdf({
    cycle: { name: "Release" },
    run: { status: "passed", created_at: "2026-01-01T00:00:00Z", summary: { total: 1, passed: 1, failed: 0, skipped: 0 }, test_results: [{ test_case_id: "same-uuid", status: "passed", test_cases: { key: "TC-002", title: "Sign in" } }] },
  })).toString("latin1");
  assert.match(pdf, /TC-002/);
});
