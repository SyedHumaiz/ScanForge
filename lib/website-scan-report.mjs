const formulaPrefix = /^[\t\r\n ]*[=+\-@]/;

const asText = value => String(value ?? "");
const statusLabel = check => {
  if (check?.status === "warning") return "Warning";
  return check?.passed ? "Passed" : "Failed";
};

export function isCompletedWebsiteScan(run) {
  return run?.source === "website" && ["passed", "failed"].includes(run.status) && Array.isArray(run.summary?.checks) && run.summary.checks.length > 0;
}

export function websiteScanTargetUrl(run, fallbackUrl = "") {
  if (run?.summary?.target_url) return run.summary.target_url;
  const availability = run?.summary?.checks?.find(check => check.category === "Availability");
  const detailUrl = asText(availability?.detail).match(/https?:\/\/[^\s,;)\]}]+/i)?.[0];
  return detailUrl || fallbackUrl;
}

export function websiteScanRelevantUrl(check) {
  if (check?.url) return check.url;
  const failure = check?.failures?.find(item => typeof item === "object" && item?.url);
  if (failure?.url) return failure.url;
  const detailUrl = asText(check?.detail).match(/https?:\/\/[^\s,;)\]}]+/i)?.[0];
  return detailUrl || "";
}

export function websiteScanRows(run, fallbackUrl = "") {
  const targetUrl = websiteScanTargetUrl(run, fallbackUrl);
  const timestamp = run?.finished_at || run?.created_at || "";
  return (run?.summary?.checks || []).map(check => [
    run?.id || "",
    targetUrl,
    timestamp,
    check?.category || "Uncategorized",
    check?.name || "Unnamed check",
    statusLabel(check),
    check?.detail || "",
    websiteScanRelevantUrl(check),
  ]);
}

export function csvCell(value) {
  const text = asText(value);
  const safe = formulaPrefix.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function buildWebsiteScanCsv(run, fallbackUrl = "") {
  const header = ["Run ID", "Website URL", "Scan timestamp", "Category", "Check name", "Status", "Details", "Relevant URL"];
  return [header, ...websiteScanRows(run, fallbackUrl)].map(row => row.map(csvCell).join(",")).join("\r\n");
}

export function websiteScanFilename(run, extension = "csv") {
  const value = run?.finished_at || run?.created_at;
  const date = value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toISOString().slice(0, 10) : "undated";
  return `scanforge-website-scan-${date}.${extension}`;
}

export function websiteScanPassPercentage(run) {
  const total = Number(run?.summary?.total) || run?.summary?.checks?.length || 0;
  const passed = Number(run?.summary?.passed) || 0;
  return total ? Math.round((passed / total) * 100) : 0;
}
