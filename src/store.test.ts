import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AnalysisStore } from "./store.js";

test("analysis cache reuses unchanged content and misses changed content", () => {
  const dir = mkdtempSync(join(tmpdir(), "family-wilma-"));
  try {
    const store = new AnalysisStore(dir);
    const identity = {
      accountId: "school-a",
      studentNumber: "42",
      messageId: 123,
      content: "Retki tiistaina",
      analyzerVersion: "v1",
    };
    assert.equal(store.get(identity), null);
    store.put(identity, {
      calendarItems: [{ title: "Retki", date: "2026-09-15", time: null, endDate: null, description: null }],
      hasOtherContent: true,
    });
    assert.equal(store.get(identity)?.calendarItems[0]?.title, "Retki");
    assert.equal(store.get({ ...identity, content: "Retki keskiviikkona" }), null);
    assert.equal(store.get({ ...identity, analyzerVersion: "v2" }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analysis batches persist pending identities and import results idempotently", () => {
  const dir = mkdtempSync(join(tmpdir(), "family-wilma-batch-"));
  try {
    const store = new AnalysisStore(dir);
    const identity = {
      accountId: "school-a",
      studentNumber: "42",
      messageId: 123,
      content: "Retki tiistaina",
      analyzerVersion: "v1",
    };
    store.reserveBatch("submission-1", [{ customId: "message_0", identity }]);
    assert.equal(store.hasPending(identity), true);
    assert.deepEqual(store.pendingBatches(), []);
    store.attachProviderBatch("submission-1", "batch-1");
    assert.deepEqual(store.pendingBatches(), [{ batchId: "submission-1", providerBatchId: "batch-1" }]);

    store.putBatchResult("submission-1", "message_0", {
      calendarItems: [],
      hasOtherContent: true,
    });
    store.putBatchResult("submission-1", "message_0", {
      calendarItems: [],
      hasOtherContent: true,
    });
    store.finishBatch("submission-1", { succeeded: 1, failed: 0 });

    assert.equal(store.get(identity)?.hasOtherContent, true);
    assert.equal(store.hasPending(identity), false);
    assert.deepEqual(store.pendingBatches(), []);
    assert.deepEqual(store.batchStatuses()[0], {
      batchId: "submission-1",
      status: "ended",
      total: 1,
      succeeded: 1,
      failed: 0,
      imported: 1,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
