import assert from "node:assert/strict";
import test from "node:test";
import type { CalendarSyncResult } from "./google.js";
import { CalendarSyncJob } from "./calendar-sync.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const result: CalendarSyncResult = { created: 1, updated: 2, deleted: 3, unchanged: 4 };

test("calendar sync starts in the background and coalesces duplicate starts", async () => {
  const pending = deferred<CalendarSyncResult>();
  let calls = 0;
  const job = new CalendarSyncJob({ sync: async () => { calls += 1; return await pending.promise; } });

  assert.equal(job.start(), true);
  assert.equal(job.start(), false);
  assert.equal(calls, 1);
  assert.equal(job.snapshot().state, "running");

  pending.resolve(result);
  await job.wait();
  assert.deepEqual(job.snapshot(), { state: "success", result, error: null, mfaAccountId: null });

  assert.equal(job.start(), true);
  await job.wait();
  assert.equal(calls, 2);
});

test("calendar sync exposes MFA and can be resumed once", async () => {
  const mfaError = new Error("MFA");
  let calls = 0;
  const job = new CalendarSyncJob({
    sync: async () => {
      calls += 1;
      if (calls === 1) throw mfaError;
      return result;
    },
    mfaAccountId: (error) => error === mfaError ? "school" : null,
  });

  job.start();
  await job.wait();
  assert.equal(job.snapshot().state, "mfa");
  assert.equal(job.claimMfa("other"), false);
  assert.equal(job.claimMfa("school"), true);
  assert.equal(job.claimMfa("school"), false);
  assert.equal(job.start(), true);
  await job.wait();
  assert.equal(job.snapshot().state, "success");
});

test("calendar sync reports failures without exposing provider details", async () => {
  const failure = new Error("private provider response");
  const reported: unknown[] = [];
  const job = new CalendarSyncJob({
    sync: async () => { throw failure; },
    reportError: (error) => reported.push(error),
  });

  job.start();
  await job.wait();
  assert.deepEqual(reported, [failure]);
  assert.deepEqual(job.snapshot(), {
    state: "error",
    result: null,
    error: "Kalenterin synkronointi epäonnistui. Yritä uudelleen.",
    mfaAccountId: null,
  });
});
