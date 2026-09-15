import assert from "node:assert/strict";
import test from "node:test";
import type { WilmaBundle } from "./wilma.js";
import { MessageLoadJob } from "./message-load.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const emptyBundle = (): WilmaBundle => ({ messages: [], structuredCalendarItems: [] });

test("message loading fetches only and coalesces duplicate starts", async () => {
  const fetched = deferred<WilmaBundle>();
  const cutoffs: Array<Date | undefined> = [];
  const job = new MessageLoadJob({
    fetch: async (options) => {
      cutoffs.push(options.sentAfter);
      return await fetched.promise;
    },
    now: () => new Date("2026-09-15T12:00:00Z"),
  });

  job.start({ includeOlder: false });
  job.start({ includeOlder: false });
  assert.equal(cutoffs.length, 1);
  assert.equal(job.snapshot().state, "fetching");
  assert.equal(cutoffs[0]?.toISOString(), "2026-08-16T12:00:00.000Z");

  fetched.resolve(emptyBundle());
  await job.wait();
  assert.equal(job.snapshot().state, "ready");
  assert.deepEqual(job.snapshot().messages, []);
});

test("an explicit older-message request is queued behind a running recent fetch", async () => {
  const firstFetch = deferred<WilmaBundle>();
  const cutoffs: Array<Date | undefined> = [];
  const job = new MessageLoadJob({
    fetch: async (options) => {
      cutoffs.push(options.sentAfter);
      if (cutoffs.length === 1) return await firstFetch.promise;
      return emptyBundle();
    },
    now: () => new Date("2026-09-15T12:00:00Z"),
  });

  job.start({ includeOlder: false });
  job.start({ includeOlder: true });
  assert.equal(job.snapshot().queuedIncludeOlder, true);
  firstFetch.resolve(emptyBundle());
  await new Promise((resolve) => setImmediate(resolve));
  await job.wait();

  assert.equal(cutoffs.length, 2);
  assert.ok(cutoffs[0]);
  assert.equal(cutoffs[1], undefined);
  assert.equal(job.snapshot().includeOlder, true);
  assert.equal(job.snapshot().state, "ready");
});

test("message loading exposes MFA requirements so the HTTP flow can resume the fetch", async () => {
  const mfaError = new Error("MFA");
  const job = new MessageLoadJob({
    fetch: async () => { throw mfaError; },
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

test("older messages are fetched only after an explicit start", async () => {
  const cutoffs: Array<Date | undefined> = [];
  const job = new MessageLoadJob({
    fetch: async (options) => {
      cutoffs.push(options.sentAfter);
      return emptyBundle();
    },
    now: () => new Date("2026-09-15T12:00:00Z"),
  });

  job.start({ includeOlder: false });
  await job.wait();
  job.start({ includeOlder: true });
  await job.wait();

  assert.equal(cutoffs[0]?.toISOString(), "2026-08-16T12:00:00.000Z");
  assert.equal(cutoffs[1], undefined);
});
