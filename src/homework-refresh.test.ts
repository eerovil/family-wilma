import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HomeworkCacheStore, homeworkCacheIdentity } from "./homework-cache.js";
import { HomeworkRefreshJob } from "./homework-refresh.js";
import type { FetchedHomework } from "./wilma.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function item(homework: string): FetchedHomework {
  return {
    accountId: "school", studentNumber: "1", child: "Child", date: "2026-09-15",
    subject: "Math", subjectCode: "MA", homework, teacher: "Teacher", teacherCode: "TEA",
  };
}

function cache(dir: string): HomeworkCacheStore {
  return new HomeworkCacheStore(dir, {
    wilma: homeworkCacheIdentity(["household"]),
    pedanet: homeworkCacheIdentity(["page"]),
  });
}

test("homework refresh serves durable cache while one coalesced refresh runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "family-wilma-homework-refresh-"));
  try {
    const store = cache(dir);
    store.putWilma([item("Stored")], "2026-09-15T10:00:00.000Z");
    const pending = deferred<FetchedHomework[]>();
    let calls = 0;
    const job = new HomeworkRefreshJob({
      cache: store,
      fetchWilma: async () => { calls += 1; return await pending.promise; },
      fetchPedanet: async () => ({
        date: "2026-09-15",
        heading: "ti 15.9.",
        content: "Fresh Peda",
        sourceUrl: "https://example.test/homework",
        personalizationStatus: "unresolved",
      }),
      now: () => new Date("2026-09-15T12:00:00.000Z"),
    });

    const firstRun = job.start();
    assert.equal(job.start(), firstRun);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(job.snapshot().state, "running");
    assert.equal(job.snapshot().homework[0]?.homework, "Stored");

    pending.resolve([item("Fresh")]);
    await job.wait();
    assert.equal(job.snapshot().state, "success");
    assert.equal(job.snapshot().homework[0]?.homework, "Fresh");
    assert.equal(job.snapshot().pedanet?.content, "Fresh Peda");
    assert.equal(cache(dir).getWilma()?.value[0]?.homework, "Fresh");
    assert.equal(cache(dir).getPedanet()?.value.content, "Fresh Peda");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed homework refresh retains the last successful snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "family-wilma-homework-failure-"));
  try {
    const store = cache(dir);
    store.putWilma([item("Stored")], "2026-09-15T10:00:00.000Z");
    const failure = new Error("private upstream response");
    const reported: unknown[] = [];
    const job = new HomeworkRefreshJob({
      cache: store,
      fetchWilma: async () => { throw failure; },
      reportError: (error) => reported.push(error),
    });

    job.start();
    await job.wait();
    assert.equal(job.snapshot().state, "error");
    assert.equal(job.snapshot().homework[0]?.homework, "Stored");
    assert.deepEqual(reported, [failure]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("homework refresh exposes MFA and resumes only after it is claimed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "family-wilma-homework-mfa-"));
  try {
    const mfa = new Error("MFA");
    let calls = 0;
    const job = new HomeworkRefreshJob({
      cache: cache(dir),
      fetchWilma: async () => {
        calls += 1;
        if (calls === 1) throw mfa;
        return [item("Fresh")];
      },
      mfaAccountId: (error) => error === mfa ? "school" : null,
    });

    job.start();
    await job.wait();
    assert.equal(job.snapshot().state, "mfa");
    assert.equal(job.claimMfa("other"), false);
    assert.equal(job.claimMfa("school"), true);
    job.start();
    await job.wait();
    assert.equal(job.snapshot().state, "success");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("homework refresh stays queued server-side and refreshes Peda while waiting for Wilma", async () => {
  const dir = mkdtempSync(join(tmpdir(), "family-wilma-homework-queue-"));
  try {
    const turn = deferred<void>();
    let wilmaCalls = 0;
    let pedanetCalls = 0;
    const job = new HomeworkRefreshJob({
      cache: cache(dir),
      waitForWilmaTurn: async () => await turn.promise,
      fetchWilma: async () => { wilmaCalls += 1; return [item("Fresh")]; },
      fetchPedanet: async () => {
        pedanetCalls += 1;
        return {
          date: "2026-09-15", heading: "ti 15.9.", content: "Peda task",
          sourceUrl: "https://example.test/homework", personalizationStatus: "unresolved",
        };
      },
    });

    job.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(job.snapshot().state, "running");
    assert.equal(wilmaCalls, 0);
    assert.equal(pedanetCalls, 1);
    assert.equal(job.snapshot().pedanet?.content, "Peda task");
    assert.equal(cache(dir).getPedanet()?.value.content, "Peda task");
    turn.resolve();
    await job.wait();
    assert.equal(wilmaCalls, 1);
    assert.equal(job.snapshot().state, "success");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
