import assert from "node:assert/strict";
import test from "node:test";
import type { CalendarSyncResult } from "./google.js";
import { AnalyzeSyncJob } from "./analyze-sync.js";

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
  });

  assert.equal(job.start([message, { ...message, messageId: 2 }]), true);
  assert.equal(job.start([message]), false);
  await job.wait();

  assert.deepEqual(submitted, [[1, 2]]);
  assert.deepEqual(states, ["refresh", "sync"]);
  assert.equal(syncCalls, 1);
  assert.deepEqual(job.snapshot(), { state: "success", result, error: null, mfaAccountId: null });
});

test("combined job refuses to sync an uncertain analysis submission", async () => {
  const reported: unknown[] = [];
  let syncCalls = 0;
  const job = new AnalyzeSyncJob({
    submit: async () => {},
    refresh: async () => {},
    pending: () => true,
    statuses: () => [{ batchId: "uncertain", status: "submitting", total: 1, succeeded: 0, failed: 0, imported: 0 }],
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
