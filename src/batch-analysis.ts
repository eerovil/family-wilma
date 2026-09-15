import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { analysisIdentities, analysisIdentity, batchAnalysisRequest, MessageAnalyzer, parseAnalysis } from "./analysis.js";
import { AnalysisStore, type AnalysisBatchStatus } from "./store.js";
import type { FetchedMessage } from "./wilma.js";

export interface AnalysisBatchAdapter {
  submit(messages: FetchedMessage[]): Promise<{ batchId: string; submitted: number } | null>;
  refresh(): Promise<void>;
  statuses(): AnalysisBatchStatus[];
}

export class AnalysisBatchService implements AnalysisBatchAdapter {
  private submitting = false;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly store: AnalysisStore,
    private readonly analyzer: MessageAnalyzer,
    private readonly anthropic: Anthropic,
  ) {}

  async submit(messages: FetchedMessage[]): Promise<{ batchId: string; submitted: number } | null> {
    if (this.submitting) throw new Error("Analysis batch submission is already in progress");
    const seen = new Set<string>();
    const selected = messages.filter((message) => {
      const identity = analysisIdentity(message);
      const key = this.store.key(identity).key;
      if (seen.has(key) || this.analyzer.cached(message)
          || analysisIdentities(message).some((candidate) => this.store.hasPending(candidate))) return false;
      seen.add(key);
      return true;
    });
    if (!selected.length) return null;
    this.submitting = true;
    try {
      const requests = selected.map((message, index) => ({
        custom_id: `message_${index}`,
        params: batchAnalysisRequest(message),
      }));
      const submissionId = randomUUID();
      this.store.reserveBatch(submissionId, selected.map((message, index) => ({
        customId: `message_${index}`,
        identity: analysisIdentity(message),
      })));
      let batch;
      try {
        batch = await this.anthropic.messages.batches.create({ requests }, { maxRetries: 0 });
      } catch (error) {
        const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
        if (status >= 400 && status < 500 && ![408, 409, 429].includes(status)) {
          this.store.finishBatch(submissionId, { succeeded: 0, failed: selected.length });
        }
        throw error;
      }
      this.store.attachProviderBatch(submissionId, batch.id);
      return { batchId: batch.id, submitted: selected.length };
    } finally {
      this.submitting = false;
    }
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return await this.refreshing;
    this.refreshing = this.refreshPending().finally(() => { this.refreshing = null; });
    return await this.refreshing;
  }

  statuses(): AnalysisBatchStatus[] {
    return this.store.batchStatuses();
  }

  private async refreshPending(): Promise<void> {
    for (const { batchId, providerBatchId } of this.store.pendingBatches()) {
      const batch = await this.anthropic.messages.batches.retrieve(providerBatchId);
      const providerFailed = batch.request_counts.errored + batch.request_counts.canceled + batch.request_counts.expired;
      this.store.updateBatch(batchId, { succeeded: batch.request_counts.succeeded, failed: providerFailed });
      if (batch.processing_status !== "ended") continue;

      let imported = 0;
      let parseFailures = 0;
      const results = await this.anthropic.messages.batches.results(providerBatchId);
      for await (const result of results) {
        if (result.result.type !== "succeeded") continue;
        try {
          const text = result.result.message.content
            .filter((block): block is Anthropic.TextBlock => block.type === "text")
            .map((block) => block.text)
            .join("");
          this.store.putBatchResult(batchId, result.custom_id, parseAnalysis(JSON.parse(text)));
          imported += 1;
        } catch {
          parseFailures += 1;
        }
      }
      this.store.finishBatch(batchId, {
        succeeded: imported,
        failed: providerFailed + parseFailures + Math.max(0, batch.request_counts.succeeded - imported - parseFailures),
      });
    }
  }
}
