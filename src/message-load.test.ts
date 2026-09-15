import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MessageCacheStore } from "./message-cache.js";
import { MessageLoadJob } from "./message-load.js";
import type { WilmaBundle } from "./wilma.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const emptyBundle = (): WilmaBundle => ({ messages: [], structuredCalendarItems: [], lessonCalendars: [], lessonWindow: null });
const message = (subject: string) => ({
  accountId: "school", studentNumber: "1", child: "Child", messageId: 1,
  subject, sender: "Teacher", sentAt: new Date("2026-09-15T10:00:00Z"), content: "Body",
});

async function withCache(run: (dir: string, cache: MessageCacheStore) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "family-wilma-message-load-"));
  try {
    await run(dir, new MessageCacheStore(dir, "household"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("fresh cached messages render immediately without a Wilma request", async () => await withCache(async (_dir, cache) => {
  cache.put({ messages: [message("Stored")], structuredCalendarItems: [] }, "2026-09-15T12:00:01.000Z");
  let calls = 0;
  const job = new MessageLoadJob({
    cache,
    fetch: async () => { calls += 1; return emptyBundle(); },
    now: () => new Date("2026-09-15T12:15:00.000Z"),
  });

  assert.equal(job.snapshot().state, "ready");
  assert.equal(job.snapshot().messages[0]?.subject, "Stored");
  assert.equal(job.start(), false);
  assert.equal(calls, 0);
}));

test("a fifteen-minute-old snapshot refreshes while keeping cached cards visible", async () => await withCache(async (dir, cache) => {
  cache.put({ messages: [message("Stored")], structuredCalendarItems: [] }, "2026-09-15T12:00:00.000Z");
  const fetched = deferred<WilmaBundle>();
  const cutoffs: Date[] = [];
  const job = new MessageLoadJob({
    cache,
    fetch: async (options) => { cutoffs.push(options.sentAfter); return await fetched.promise; },
    now: () => new Date("2026-09-15T12:15:00.000Z"),
  });

  assert.equal(job.start(), true);
  assert.equal(job.start(), false);
  assert.equal(job.snapshot().state, "fetching");
  assert.equal(job.snapshot().messages[0]?.subject, "Stored");
  assert.equal(cutoffs[0]?.toISOString(), "2026-08-16T12:15:00.000Z");

  fetched.resolve({ ...emptyBundle(), messages: [message("Fresh")] });
  await job.wait();
  assert.equal(job.snapshot().state, "ready");
  assert.equal(job.snapshot().messages[0]?.subject, "Fresh");
  assert.equal(new MessageCacheStore(dir, "household").get()?.messages[0]?.subject, "Fresh");
}));

test("explicit refresh bypasses the freshness window", async () => await withCache(async (_dir, cache) => {
  cache.put({ messages: [message("Stored")], structuredCalendarItems: [] }, "2026-09-15T12:14:59.000Z");
  let calls = 0;
  const job = new MessageLoadJob({
    cache,
    fetch: async () => { calls += 1; return emptyBundle(); },
    now: () => new Date("2026-09-15T12:15:00.000Z"),
  });

  assert.equal(job.start({ force: true }), true);
  await job.wait();
  assert.equal(calls, 1);
}));

test("message loading exposes MFA requirements so the HTTP flow can resume", async () => await withCache(async (_dir, cache) => {
  const mfaError = new Error("MFA");
  const job = new MessageLoadJob({
    cache,
    fetch: async () => { throw mfaError; },
    mfaAccountId: (error) => error === mfaError ? "school" : null,
  });

  job.start();
  await job.wait();
  assert.equal(job.snapshot().state, "mfa");
  assert.equal(job.claimMfa("other"), false);
  assert.equal(job.claimMfa("school"), true);
  assert.equal(job.claimMfa("school"), false);
}));

test("failed refresh retains the cached message snapshot", async () => await withCache(async (_dir, cache) => {
  cache.put({ messages: [message("Stored")], structuredCalendarItems: [] }, "2026-09-15T10:00:00.000Z");
  const failure = new Error("Wilma unavailable");
  const reported: unknown[] = [];
  const job = new MessageLoadJob({
    cache,
    fetch: async () => { throw failure; },
    reportError: (error) => reported.push(error),
    now: () => new Date("2026-09-15T12:15:00.000Z"),
  });

  job.start();
  await job.wait();
  assert.deepEqual(reported, [failure]);
  assert.equal(job.snapshot().state, "error");
  assert.equal(job.snapshot().messages[0]?.subject, "Stored");
}));
