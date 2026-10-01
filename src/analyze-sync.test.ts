import assert from "node:assert/strict";
import test from "node:test";
import type { CalendarSyncResult } from "./google.js";
import { AnalyzeSyncJob, formatDuration } from "./analyze-sync.js";

const message = {
  accountId: "school", studentNumber: "1", child: "Child", messageId: 1,
  subject: "Subject", sender: "Teacher", sentAt: new Date("2026-09-15T10:00:00Z"), content: "Body",
};
const result: CalendarSyncResult = { created: 1, updated: 2, deleted: 3, unchanged: 4 };

test("combined job analyzes every message before calendar sync", async () => {
  const submitted: number[][] = [];
  let pending = true;
  let syncCalls = 0;
  const states: string[] = [];
  const job = new AnalyzeSyncJob({
    submit: async (messages) => { submitted.push(messages.map((item) => item.messageId)); },
    refresh: async () => { states.push("refresh"); pending = false; },
    pending: () => pending,
    statuses: () => [],
    sync: async () => { states.push("sync"); syncCalls += 1; return result; },
    pause: async () => {},
    now: () => new Date("2026-09-16T08:00:00.000Z"),
  });

  assert.equal(job.start([message, { ...message, messageId: 2 }]), true);
  assert.equal(job.start([message]), false);
  await job.wait();

  assert.deepEqual(submitted, [[1, 2]]);
  assert.deepEqual(states, ["refresh", "sync"]);
  assert.equal(syncCalls, 1);
  assert.deepEqual(job.snapshot(), { state: "success", result, error: null, mfaAccountId: null, finishedAt: "2026-09-16T08:00:00.000Z" });
});

test("combined job refuses to sync an uncertain analysis submission", async () => {
  const reported: unknown[] = [];
  let syncCalls = 0;
  const job = new AnalyzeSyncJob({
    submit: async () => {},
    refresh: async () => {},
    pending: () => true,
    statuses: () => [{ batchId: "uncertain", status: "submitting", total: 1, succeeded: 0, failed: 0, imported: 0, updatedAt: "2026-09-16T08:00:00.000Z" }],
    sync: async () => { syncCalls += 1; return result; },
    reportError: (error) => reported.push(error),
  });

  job.start([message]);
  await job.wait();
  assert.equal(syncCalls, 0);
  assert.equal(reported.length, 1);
  assert.equal(job.snapshot().state, "error");
});

test("combined job resumes only the calendar phase after MFA", async () => {
  const mfa = new Error("MFA");
  let submitCalls = 0;
  let syncCalls = 0;
  const job = new AnalyzeSyncJob({
    submit: async () => { submitCalls += 1; },
    refresh: async () => {},
    pending: () => false,
    statuses: () => [],
    sync: async () => {
      syncCalls += 1;
      if (syncCalls === 1) throw mfa;
      return result;
    },
    mfaAccountId: (error) => error === mfa ? "school" : null,
  });

  job.start([message]);
  await job.wait();
  assert.equal(job.snapshot().state, "mfa");
  assert.equal(job.claimMfa("other"), false);
  assert.equal(job.claimMfa("school"), true);
  assert.equal(job.start([]), true);
  await job.wait();
  assert.equal(submitCalls, 1);
  assert.equal(syncCalls, 2);
  assert.equal(job.snapshot().state, "success");
});

test("combined job stays in the analysis state until Wilma is free, then syncs and logs the batch", async () => {
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const logged: string[] = [];
  let pending = true;
  let syncCalls = 0;
  const job = new AnalyzeSyncJob({
    submit: async () => {},
    refresh: async () => { pending = false; },
    pending: () => pending,
    statuses: () => [],
    sync: async () => { syncCalls += 1; return result; },
    waitForWilmaTurn: async () => await turn,
    log: (line) => logged.push(line),
    pause: async () => {},
  });

  job.start([message]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(job.snapshot().state, "analyzing");
  assert.equal(syncCalls, 0);
  assert.match(logged[0] ?? "", /^analysis batch \d+\.\ds \(1 messages\)$/);

  release();
  await job.wait();
  assert.equal(syncCalls, 1);
  assert.equal(job.snapshot().state, "success");
});

test("durations read as seconds, minutes or hours", () => {
  assert.equal(formatDuration(4_349), "4.3s");
  assert.equal(formatDuration(38 * 60_000 + 12_000), "38m12s");
  assert.equal(formatDuration(3 * 3_600_000 + 5 * 60_000), "3h5m");
});
