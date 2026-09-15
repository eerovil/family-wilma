import assert from "node:assert/strict";
import test from "node:test";
import type { MessageAnalysis } from "./store.js";
import type { FetchedMessage, WilmaBundle } from "./wilma.js";
import { MessageLoadJob } from "./message-load.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function message(messageId: number): FetchedMessage {
  return {
    accountId: "school",
    studentNumber: "101",
    child: "Child",
    messageId,
    subject: `Message ${messageId}`,
    sender: "Teacher",
    sentAt: new Date("2026-09-14T08:00:00Z"),
    content: "Content",
  };
}

test("message loading starts immediately, reports progress, and coalesces duplicate starts", async () => {
  const fetched = deferred<WilmaBundle>();
  const analyzed = deferred<{ analysis: MessageAnalysis; cached: boolean }>();
  const cutoffs: Array<Date | undefined> = [];
  let fetchCalls = 0;
  let analyzeCalls = 0;
  const job = new MessageLoadJob({
    fetch: async (options) => {
      fetchCalls += 1;
      cutoffs.push(options.sentAfter);
      return await fetched.promise;
    },
    analyze: async () => {
      analyzeCalls += 1;
      return await analyzed.promise;
    },
    now: () => new Date("2026-09-15T12:00:00Z"),
  });

  job.start({ includeOlder: false });
  job.start({ includeOlder: false });
  assert.equal(fetchCalls, 1);
  assert.deepEqual(job.snapshot(), {
    state: "fetching",
    includeOlder: false,
    completed: 0,
    total: 0,
    messages: [],
    error: null,
    mfaAccountId: null,
    queuedIncludeOlder: false,
  });
  assert.equal(cutoffs[0]?.toISOString(), "2026-08-16T12:00:00.000Z");

  fetched.resolve({ messages: [message(1)], structuredCalendarItems: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(job.snapshot().state, "analyzing");
  assert.equal(job.snapshot().total, 1);
  assert.equal(analyzeCalls, 1);

  analyzed.resolve({ analysis: { calendarItems: [], hasOtherContent: true }, cached: false });
  await job.wait();
  assert.equal(job.snapshot().state, "ready");
  assert.equal(job.snapshot().completed, 1);
  assert.equal(job.snapshot().messages.length, 1);
});

test("an explicit older-message request is queued behind a running recent job", async () => {
  const firstFetch = deferred<WilmaBundle>();
  const cutoffs: Array<Date | undefined> = [];
  const job = new MessageLoadJob({
    fetch: async (options) => {
      cutoffs.push(options.sentAfter);
      if (cutoffs.length === 1) return await firstFetch.promise;
      return { messages: [], structuredCalendarItems: [] };
    },
    analyze: async () => ({ analysis: { calendarItems: [], hasOtherContent: false }, cached: true }),
    now: () => new Date("2026-09-15T12:00:00Z"),
  });

  job.start({ includeOlder: false });
  job.start({ includeOlder: true });
  assert.equal(job.snapshot().queuedIncludeOlder, true);
  firstFetch.resolve({ messages: [], structuredCalendarItems: [] });
  await new Promise((resolve) => setImmediate(resolve));
  await job.wait();

  assert.equal(cutoffs.length, 2);
  assert.ok(cutoffs[0]);
  assert.equal(cutoffs[1], undefined);
  assert.equal(job.snapshot().includeOlder, true);
  assert.equal(job.snapshot().state, "ready");
});

test("message loading exposes MFA requirements so the HTTP flow can resume the job", async () => {
  const mfaError = new Error("MFA");
  const job = new MessageLoadJob({
    fetch: async () => { throw mfaError; },
    analyze: async () => ({ analysis: { calendarItems: [], hasOtherContent: false }, cached: true }),
    mfaAccountId: (error) => error === mfaError ? "school" : null,
  });

  job.start({ includeOlder: false });
  await job.wait();

  assert.equal(job.snapshot().state, "mfa");
  assert.equal(job.snapshot().mfaAccountId, "school");
  assert.equal(job.claimMfa("other"), false);
  assert.equal(job.claimMfa("school"), true);
  assert.equal(job.claimMfa("school"), false);
});

test("older messages are included only after an explicit start", async () => {
  const cutoffs: Array<Date | undefined> = [];
  const job = new MessageLoadJob({
    fetch: async (options) => {
      cutoffs.push(options.sentAfter);
      return { messages: [], structuredCalendarItems: [] };
    },
    analyze: async () => ({ analysis: { calendarItems: [], hasOtherContent: false }, cached: true }),
    now: () => new Date("2026-09-15T12:00:00Z"),
  });

  job.start({ includeOlder: false });
  await job.wait();
  job.start({ includeOlder: true });
  await job.wait();

  assert.equal(cutoffs[0]?.toISOString(), "2026-08-16T12:00:00.000Z");
  assert.equal(cutoffs[1], undefined);
});
