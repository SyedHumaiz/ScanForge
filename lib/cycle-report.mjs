import { jsPDF } from "jspdf";

const colors = { ink: [38, 52, 64], muted: [92, 105, 116], green: [6, 118, 71], red: [180, 35, 24], amber: [181, 71, 8] };
const safe = value => String(value ?? "—");
const statusLabel = value => value === "skipped" ? "Not Automated" : value ? value[0].toUpperCase() + value.slice(1) : "Unknown";

export function cycleReportFilename(cycleName, runId) {
  const name = String(cycleName || "cycle").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "cycle";
  return `scanforge-${name}-execution-${String(runId || "report").slice(0, 8)}.pdf`;
}

export function buildCycleReportPdf({ cycle, run }) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const margin = 16, width = doc.internal.pageSize.getWidth(), height = doc.internal.pageSize.getHeight(), content = width - margin * 2;
  let y = 0;
  const header = () => {
    doc.setFillColor(24, 38, 45); doc.rect(0, 0, width, 22, "F");
    doc.setTextColor(255, 255, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(15); doc.text("ScanForge", margin, 14);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.text("Automated Website Testing & Quality Analysis", width - margin, 14, { align: "right" });
    doc.setTextColor(...colors.ink); y = 32;
  };
  const nextPage = () => { doc.addPage(); header(); };
  const space = amount => { if (y + amount > height - 18) nextPage(); };
  const text = (value, x = margin, maxWidth = content, size = 9, leading = 4.5) => {
    doc.setFontSize(size); const lines = doc.splitTextToSize(safe(value), maxWidth); space(lines.length * leading); doc.text(lines, x, y); y += lines.length * leading; return lines.length;
  };
  const label = (name, value) => { doc.setFont("helvetica", "bold"); text(name, margin, content, 8, 4); doc.setFont("helvetica", "normal"); text(value, margin, content, 9, 4.5); y += 1; };
  header(); doc.setFont("helvetica", "bold"); doc.setFontSize(20); doc.text("Test Cycle Execution Report", margin, y); y += 9;
  doc.setFont("helvetica", "normal"); label("Test cycle", cycle.name); label("Target website", run.summary?.target_url); label("Execution date and time", new Date(run.finished_at || run.created_at).toLocaleString()); label("Overall execution status", statusLabel(run.status));
  const summary = run.summary || {}; label("Total test cases", summary.total); label("Passed", summary.passed); label("Failed", summary.failed); label("Not Automated", summary.skipped);
  space(12); doc.setFont("helvetica", "bold"); doc.setFontSize(13); doc.text("Test case results", margin, y); y += 8;
  const columns = [margin, margin + 40, margin + 105, margin + 130];
  const drawTableHeader = () => { space(12); doc.setFillColor(244, 248, 246); doc.rect(margin, y - 5, content, 10, "F"); doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(...colors.ink); doc.text("Test case", columns[0] + 2, y); doc.text("Result", columns[1], y); doc.text("Duration", columns[2], y); doc.text("Reason", columns[3], y); y += 8; };
  drawTableHeader();
  for (const result of (run.test_results || [])) {
    const title = result.test_cases?.title || result.test_case_id || "Deleted test case";
    const reason = result.error_message || "—";
    const titleLines = doc.splitTextToSize(safe(title), 36), reasonLines = doc.splitTextToSize(safe(reason), 40), rowHeight = Math.max(titleLines.length, reasonLines.length, 1) * 4 + 5;
    if (y + rowHeight > height - 18) drawTableHeader();
    const color = result.status === "passed" ? colors.green : result.status === "failed" ? colors.red : colors.amber;
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...colors.ink); doc.text(titleLines, columns[0] + 2, y); doc.setTextColor(...color); doc.text(statusLabel(result.status), columns[1], y); doc.setTextColor(...colors.muted); doc.text(result.duration_ms != null ? `${result.duration_ms} ms` : "—", columns[2], y); doc.text(reasonLines, columns[3], y); y += rowHeight; doc.setDrawColor(234, 236, 240); doc.line(margin, y - 2, width - margin, y - 2);
  }
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) { doc.setPage(page); doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(...colors.muted); doc.text("ScanForge test cycle execution report", margin, height - 9); doc.text(`Page ${page} of ${pages}`, width - margin, height - 9, { align: "right" }); }
  return doc.output("arraybuffer");
}
