export const runPollIntervalMs = 3000;
export const runPollTimeoutMs = 10 * 60 * 1000;
export const terminalRunStatuses = new Set(["passed", "failed", "cancelled"]);

export function startRunPolling({ runId, refresh, onUpdate, onTimeout, intervalMs = runPollIntervalMs, timeoutMs = runPollTimeoutMs }) {
  let active = true;
  const startedAt = Date.now();
  let timer = null;
  const stop = () => { active = false; if (timer) clearTimeout(timer); timer = null; };
  const schedule = () => { if (active) timer = setTimeout(tick, intervalMs); };
  async function tick() {
    if (!active) return;
    if (Date.now() - startedAt > timeoutMs) { stop(); onTimeout?.(); return; }
    try {
      const data = await refresh();
      if (!active) return;
      const run = data?.runs?.find(item => item.id === runId);
      if (run) {
        onUpdate?.(run);
        if (terminalRunStatuses.has(run.status)) { stop(); return; }
      }
    } catch (error) {
      if (active) onUpdate?.(null, error);
    }
    schedule();
  }
  void tick();
  return stop;
}
