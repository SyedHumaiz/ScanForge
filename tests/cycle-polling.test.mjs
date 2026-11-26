import test from "node:test";
import assert from "node:assert/strict";
import { startRunPolling, runPollIntervalMs, runPollTimeoutMs, terminalRunStatuses } from "../lib/run-polling.mjs";

test("cycle polling uses a three-second cadence and terminal statuses", () => {
  assert.equal(runPollIntervalMs, 3000);
  assert.equal(runPollTimeoutMs, 600000);
  assert.deepEqual([...terminalRunStatuses].sort(), ["cancelled", "failed", "passed"]);
});

test("cycle polling timeout does not fabricate a result", () => {
  assert.equal(terminalRunStatuses.has("queued"), false);
  assert.equal(terminalRunStatuses.has("running"), false);
});

test("shared polling follows queued, running, and passed without fabricating results", async () => {
  const seen = [];
  let calls = 0;
  let stop;
  await new Promise(resolve => {
    stop = startRunPolling({
      runId: "run-1",
      intervalMs: 1,
      timeoutMs: 100,
      refresh: async () => ({ runs: [{ id: "run-1", status: ["queued", "running", "passed"][Math.min(calls++, 2)] }] }),
      onUpdate: run => { seen.push(run.status); if (run.status === "passed") resolve(); },
    });
  });
  stop();
  assert.deepEqual(seen, ["queued", "running", "passed"]);
  assert.equal(calls, 3);
});
