import test from "node:test";
import assert from "node:assert/strict";
import { buildWebsiteScanCsv, isCompletedWebsiteScan, websiteScanFilename, websiteScanRows } from "../lib/website-scan-report.mjs";

const completedRun = {
  id: "run-123",
  source: "website",
  status: "failed",
  created_at: "2026-11-17T08:30:00.000Z",
  summary: {
    target_url: "https://example.test/long-path",
    total: 2,
    passed: 1,
    failed: 1,
    warnings: 0,
    checks: [
      { category: "SEO", name: "Page title", passed: true, status: "passed", detail: "A title is present" },
      { category: "Links", name: "Internal links respond", passed: false, status: "failed", detail: '=HYPERLINK("https://unsafe.test")', failures: [{ url: "https://example.test/broken" }] },
    ],
  },
};

test("completed website scans include failed quality findings", () => {
  assert.equal(isCompletedWebsiteScan(completedRun), true);
  assert.equal(websiteScanRows(completedRun)[1][5], "Failed");
  assert.equal(websiteScanRows(completedRun)[1][7], "https://example.test/broken");
});

test("queued and empty website scans cannot produce completed reports", () => {
  assert.equal(isCompletedWebsiteScan({ ...completedRun, status: "queued" }), false);
  assert.equal(isCompletedWebsiteScan({ ...completedRun, summary: {} }), false);
});

test("website scan CSV escapes quotes and spreadsheet formulas", () => {
  const csv = buildWebsiteScanCsv(completedRun);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/unsafe\.test""\)"/);
  assert.match(csv, /"https:\/\/example\.test\/broken"/);
});

test("website scan filenames use the persisted scan date", () => {
  assert.equal(websiteScanFilename(completedRun), "scanforge-website-scan-2026-11-17.csv");
});
