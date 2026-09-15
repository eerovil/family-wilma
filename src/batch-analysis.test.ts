import Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AnalysisBatchService } from "./batch-analysis.js";
import { analysisIdentity, MessageAnalyzer } from "./analysis.js";
import { AnalysisStore } from "./store.js";
import type { FetchedMessage } from "./wilma.js";

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

test("selected uncached messages are submitted once and imported by custom id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "family-wilma-batch-service-"));
  const created: unknown[] = [];
  const createOptions: unknown[] = [];
  const fakeAnthropic = {
    messages: {
      batches: {
        create: async (params: unknown, options: unknown) => {
          created.push(params);
          createOptions.push(options);
          return { id: "batch-1" };
        },
        retrieve: async () => ({
          processing_status: "ended",
          request_counts: { succeeded: 1, errored: 0, canceled: 0, expired: 0, processing: 0 },
        }),
        results: async () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              custom_id: "message_0",
              result: {
                type: "succeeded",
                message: { content: [{ type: "text", text: '{"calendarItems":[],"hasOtherContent":true}' }] },
              },
            };
          },
        }),
      },
    },
  } as unknown as Anthropic;

  try {
    const store = new AnalysisStore(dir);
    const analyzer = new MessageAnalyzer("test", store, fakeAnthropic);
    const batches = new AnalysisBatchService(store, analyzer, fakeAnthropic);
    assert.deepEqual(await batches.submit([message(1), message(1)]), { batchId: "batch-1", submitted: 1 });
    assert.equal(created.length, 1);
    assert.deepEqual(createOptions, [{ maxRetries: 0 }]);
    const request = created[0] as { requests: Array<{ custom_id: string; params: { output_config?: { format?: { type?: string } } } }> };
    assert.equal(request.requests.length, 1, "duplicate identities in one form must be submitted once");
    assert.equal(request.requests[0]?.custom_id, "message_0");
    assert.equal(request.requests[0]?.params.output_config?.format?.type, "json_schema");
    assert.equal(await batches.submit([message(1)]), null, "pending messages must not be charged twice");

    const restartedStore = new AnalysisStore(dir);
    const restartedAnalyzer = new MessageAnalyzer("test", restartedStore, fakeAnthropic);
    const restartedBatches = new AnalysisBatchService(restartedStore, restartedAnalyzer, fakeAnthropic);
    assert.equal(await restartedBatches.submit([message(1)]), null, "pending state must survive a restart");
    await restartedBatches.refresh();

    assert.equal(restartedAnalyzer.cached(message(1))?.hasOtherContent, true);
    assert.equal(restartedBatches.statuses()[0]?.status, "ended");
    assert.equal(restartedBatches.statuses()[0]?.imported, 1);
    assert.equal(await restartedBatches.submit([message(1)]), null, "cached messages must not be charged twice");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an uncertain provider response leaves a durable reservation instead of risking a duplicate charge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "family-wilma-batch-uncertain-"));
  let createCalls = 0;
  const fakeAnthropic = {
    messages: {
      batches: {
        create: async () => {
          createCalls += 1;
          throw new Error("connection lost after request write");
        },
      },
    },
  } as unknown as Anthropic;

  try {
    const store = new AnalysisStore(dir);
    const analyzer = new MessageAnalyzer("test", store, fakeAnthropic);
    const batches = new AnalysisBatchService(store, analyzer, fakeAnthropic);
    await assert.rejects(batches.submit([message(2)]));
    assert.equal(store.hasPending(analysisIdentity(message(2))), true);
    assert.equal(store.batchStatuses()[0]?.status, "submitting");
    assert.equal(await batches.submit([message(2)]), null);
    assert.equal(createCalls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
