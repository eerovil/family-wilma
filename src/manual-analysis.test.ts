import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analysisIdentity } from "./analysis.js";
import { ManualAnalysisAdapter } from "./manual-analysis.js";
import { AnalysisStore } from "./store.js";
import type { FetchedMessage } from "./wilma.js";

const message = (): FetchedMessage => ({
  accountId: "school",
  studentNumber: "101",
  child: "Child",
  messageId: 42,
  subject: "Retki",
  sender: "Teacher",
  sentAt: new Date("2026-09-15T08:00:00Z"),
  content: "Retki on 20.9.2026.",
});

test("manual analysis queues selected content privately and imports a complete result", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "family-wilma-manual-"));
  try {
    const store = new AnalysisStore(dataDir);
    const adapter = new ManualAnalysisAdapter(dataDir, store);
    const submitted = await adapter.submit([message(), message()]);
    assert.ok(submitted);
    assert.equal(submitted.submitted, 1);
    assert.equal(await adapter.submit([message()]), null);

    const request = adapter.read(submitted.batchId);
    assert.equal(request.messages[0]?.content, "Retki on 20.9.2026.");
    assert.equal(request.messages[0]?.customId, "message_0");
    const queueDir = join(dataDir, "manual-analysis");
    const requestPath = join(queueDir, `${submitted.batchId}.json`);
    assert.equal(statSync(queueDir).mode & 0o777, 0o700);
    assert.equal(statSync(requestPath).mode & 0o777, 0o600);
    assert.deepEqual(adapter.pending(), [{
      batchId: submitted.batchId,
      messages: 1,
      createdAt: request.createdAt,
    }]);
    const exportedPath = join(dataDir, "agent-request.json");
    assert.deepEqual(adapter.export(submitted.batchId, exportedPath), { path: exportedPath, messages: 1 });
    assert.equal(statSync(exportedPath).mode & 0o777, 0o600);

    assert.deepEqual(adapter.import(submitted.batchId, {
      version: 1,
      batchId: submitted.batchId,
      results: [{
        customId: "message_0",
        analysis: {
          calendarItems: [{ title: "Retki", date: "2026-09-20", time: null, endDate: null, description: null }],
          hasOtherContent: true,
        },
      }],
    }), { imported: 1 });

    assert.equal(store.get(analysisIdentity(message()))?.calendarItems[0]?.title, "Retki");
    assert.equal(adapter.statuses()[0]?.status, "ended");
    assert.equal(adapter.statuses()[0]?.imported, 1);
    assert.equal(existsSync(requestPath), false, "private message body is deleted after import");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("manual analysis rejects incomplete results without changing pending state", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "family-wilma-manual-invalid-"));
  try {
    const store = new AnalysisStore(dataDir);
    const adapter = new ManualAnalysisAdapter(dataDir, store);
    const submitted = await adapter.submit([message()]);
    assert.ok(submitted);

    assert.throws(() => adapter.import(submitted.batchId, {
      version: 1,
      batchId: submitted.batchId,
      results: [],
    }), /incomplete/);
    assert.throws(() => adapter.import(submitted.batchId, {
      version: 1,
      batchId: submitted.batchId,
      results: [{ customId: "message_0", analysis: { calendarItems: [], hasOtherContent: "yes" } }],
    }), /invalid/);
    assert.throws(() => adapter.import(submitted.batchId, {
      version: 1,
      batchId: submitted.batchId,
      results: [{ customId: "message_0", analysis: { calendarItems: [], hasOtherContent: true, extra: true } }],
    }), /invalid/);
    assert.equal(store.hasPending(analysisIdentity(message())), true);
    assert.equal(adapter.pending().length, 1);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
