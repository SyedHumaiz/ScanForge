import test from "node:test";
import assert from "node:assert/strict";
import { buildCycleReportPdf, cycleReportFilename } from "../lib/cycle-report.mjs";

test("cycle report is a readable PDF built from the persisted run shape", () => {
  const bytes = buildCycleReportPdf({
    cycle: { name: "Demo Cycle" },
    run: {
      id: "12345678-aaaa-bbbb-cccc-123456789abc", status: "failed", created_at: "2026-11-18T10:00:00.000Z", finished_at: "2026-11-18T10:00:04.000Z",
      summary: { target_url: "https://pdfmaker-pi.vercel.app/", total: 2, passed: 1, failed: 1, skipped: 0 },
      test_results: [
        { test_cases: { title: "Homepage responds" }, status: "passed", duration_ms: 1000, error_message: null },
        { test_cases: { title: "Homepage has one H1" }, status: "failed", duration_ms: 3000, error_message: "Found 0 H1 elements." },
      ],
    },
  });
  const pdf = Buffer.from(bytes).toString("latin1");
  assert.ok(pdf.startsWith("%PDF-"));
  assert.ok(pdf.includes("Test Cycle Execution Report"));
  assert.ok(pdf.includes("Demo Cycle"));
  assert.ok(pdf.includes("Homepage has one H1"));
  assert.match(cycleReportFilename("Demo Cycle", "12345678-test"), /^scanforge-demo-cycle-execution-12345678\.pdf$/);
});
