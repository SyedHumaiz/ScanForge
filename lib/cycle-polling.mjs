export const cyclePollIntervalMs = 3000;
export const cyclePollTimeoutMs = 10 * 60 * 1000;
export const cycleTerminalStatuses = new Set(["passed", "failed", "cancelled"]);
export const isTerminalCycleRun = status => cycleTerminalStatuses.has(status);
export const cyclePollTimedOut = (startedAt, now = Date.now()) => now - startedAt > cyclePollTimeoutMs;
