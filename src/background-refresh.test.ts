import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundRefresh, type BackgroundRefreshStep } from "./background-refresh.js";

function setup(options: { hours?: number; oldest?: string | null; steps?: BackgroundRefreshStep[] } = {}) {
  const calls: string[] = [];
  const errors: string[] = [];
  const timers: number[] = [];
  const steps = options.steps ?? ["messages", "homework"].map((name) => ({
    name,
    run: async () => { calls.push(name); return "done" as const; },
  }));
  const refresh = new BackgroundRefresh({
    intervalHours: options.hours ?? 3,
    steps,
    oldestUpdatedAt: () => (options.oldest === undefined ? "2026-10-05T05:00:00.000Z" : options.oldest),
    reportError: (_error, step) => errors.push(step),
    now: () => new Date("2026-10-05T06:00:00.000Z"),
    setInterval: (_run, ms) => { timers.push(ms); return {}; },
  });
  return { refresh, calls, errors, timers };
}

test("steps run one after another, in order", async () => {
  const { refresh, calls } = setup();
  await refresh.runOnce();
  assert.deepEqual(calls, ["messages", "homework"]);
});

test("a step waiting for a login code is skipped and reported, and the next step still runs", async () => {
  const calls: string[] = [];
  const { refresh, errors } = setup({
    steps: [
      { name: "messages", run: async () => { calls.push("messages"); return "mfa"; } },
      { name: "homework", run: async () => { calls.push("homework"); throw new Error("down"); } },
    ],
  });
  await refresh.runOnce();
  assert.deepEqual(calls, ["messages", "homework"]);
  assert.deepEqual(errors, ["messages", "homework"]);
});

test("0 hours turns it off", () => {
  const { refresh, timers, calls } = setup({ hours: 0, oldest: null });
  assert.equal(refresh.start(), false);
  assert.deepEqual(timers, []);
  assert.deepEqual(calls, []);
});

test("startup runs at once only when saved data is older than the interval", () => {
  const fresh = setup();
  assert.equal(fresh.refresh.start(), true);
  assert.deepEqual(fresh.timers, [3 * 60 * 60 * 1_000]);
  assert.deepEqual(fresh.calls, []);

  const stale = setup({ oldest: "2026-10-05T02:00:00.000Z" });
  stale.refresh.start();
  assert.deepEqual(stale.calls, ["messages"]);

  const never = setup({ oldest: null });
  never.refresh.start();
  assert.deepEqual(never.calls, ["messages"]);
});

test("a run already in progress is joined, not started twice", async () => {
  const { refresh, calls } = setup();
  await Promise.all([refresh.runOnce(), refresh.runOnce()]);
  assert.deepEqual(calls, ["messages", "homework"]);
});
