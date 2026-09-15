import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ANALYSIS_INSTRUCTIONS, analysisIdentity } from "./analysis.js";
import type { AnalysisBatchAdapter } from "./batch-analysis.js";
import { AnalysisStore, type AnalysisBatchStatus, type MessageAnalysis } from "./store.js";
import type { FetchedMessage } from "./wilma.js";

interface ManualRequestMessage {
  customId: string;
  child: string;
  sentAt: string;
  subject: string;
  sender: string;
  content: string;
}

export interface ManualAnalysisRequest {
  version: 1;
  batchId: string;
  createdAt: string;
  instructions: string[];
  messages: ManualRequestMessage[];
}

export interface ManualAnalysisResults {
  version: 1;
  batchId: string;
  results: Array<{ customId: string; analysis: unknown }>;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}

function parseManualAnalysis(value: unknown): MessageAnalysis {
  if (!value || typeof value !== "object") throw new Error("Manual analysis is invalid");
  const object = value as Record<string, unknown>;
  if (!hasExactKeys(object, ["calendarItems", "hasOtherContent"]) ||
      !Array.isArray(object.calendarItems) || typeof object.hasOtherContent !== "boolean") {
    throw new Error("Manual analysis is invalid");
  }
  const calendarItems = object.calendarItems.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Manual calendar item is invalid");
    const item = entry as Record<string, unknown>;
    if (!hasExactKeys(item, ["title", "date", "time", "endDate", "description"]) ||
        typeof item.title !== "string" || !item.title.trim() || !validDate(item.date) ||
        !(item.time === null || typeof item.time === "string") ||
        !(item.endDate === null || validDate(item.endDate)) ||
        !(item.description === null || typeof item.description === "string")) {
      throw new Error("Manual calendar item is invalid");
    }
    return {
      title: item.title.trim(),
      date: item.date,
      time: item.time,
      endDate: item.endDate,
      description: item.description,
    };
  });
  return { calendarItems, hasOtherContent: object.hasOtherContent };
}

export class ManualAnalysisAdapter implements AnalysisBatchAdapter {
  private readonly queueDir: string;
  private submitting = false;

  constructor(dataDir: string, private readonly store: AnalysisStore) {
    this.queueDir = join(dataDir, "manual-analysis");
    mkdirSync(this.queueDir, { recursive: true, mode: 0o700 });
    chmodSync(this.queueDir, 0o700);
  }

  async submit(messages: FetchedMessage[]): Promise<{ batchId: string; submitted: number } | null> {
    if (this.submitting) throw new Error("Manual analysis submission is already in progress");
    const seen = new Set<string>();
    const selected = messages.filter((message) => {
      const identity = analysisIdentity(message);
      const key = this.store.key(identity).key;
      if (seen.has(key) || this.store.get(identity) || this.store.hasPending(identity)) return false;
      seen.add(key);
      return true;
    });
    if (!selected.length) return null;

    this.submitting = true;
    try {
      const batchId = `manual-${randomUUID()}`;
      const request: ManualAnalysisRequest = {
        version: 1,
        batchId,
        createdAt: new Date().toISOString(),
        instructions: [...ANALYSIS_INSTRUCTIONS],
        messages: selected.map((message, index) => ({
          customId: `message_${index}`,
          child: message.child,
          sentAt: message.sentAt.toISOString(),
          subject: message.subject,
          sender: message.sender,
          content: message.content,
        })),
      };
      const path = this.requestPath(batchId);
      const temporary = `${path}.new`;
      writeFileSync(temporary, JSON.stringify(request, null, 2), { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
      try {
        this.store.reserveBatch(batchId, selected.map((message, index) => ({
          customId: `message_${index}`,
          identity: analysisIdentity(message),
        })));
        this.store.attachProviderBatch(batchId, batchId);
      } catch (error) {
        this.store.finishBatch(batchId, { succeeded: 0, failed: selected.length });
        unlinkSync(path);
        throw error;
      }
      return { batchId, submitted: selected.length };
    } finally {
      this.submitting = false;
    }
  }

  async refresh(): Promise<void> {}

  statuses(): AnalysisBatchStatus[] {
    return this.store.batchStatuses();
  }

  pending(): Array<{ batchId: string; messages: number; createdAt: string }> {
    return readdirSync(this.queueDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.read(name.slice(0, -5)))
      .map((request) => ({ batchId: request.batchId, messages: request.messages.length, createdAt: request.createdAt }))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  read(batchId: string): ManualAnalysisRequest {
    const value: unknown = JSON.parse(readFileSync(this.requestPath(batchId), "utf8"));
    if (!value || typeof value !== "object") throw new Error("Manual analysis request is invalid");
    const request = value as Partial<ManualAnalysisRequest>;
    if (request.version !== 1 || request.batchId !== batchId || !Array.isArray(request.messages)) {
      throw new Error("Manual analysis request is invalid");
    }
    return request as ManualAnalysisRequest;
  }

  export(batchId: string, destination: string): { path: string; messages: number } {
    const request = this.read(batchId);
    copyFileSync(this.requestPath(batchId), destination);
    chmodSync(destination, 0o600);
    return { path: destination, messages: request.messages.length };
  }

  import(batchId: string, value: unknown): { imported: number } {
    const request = this.read(batchId);
    if (!value || typeof value !== "object") throw new Error("Manual analysis results are invalid");
    const resultObject = value as Record<string, unknown>;
    const results = value as Partial<ManualAnalysisResults>;
    if (!hasExactKeys(resultObject, ["version", "batchId", "results"]) ||
        results.version !== 1 || results.batchId !== batchId || !Array.isArray(results.results)) {
      throw new Error("Manual analysis results are invalid");
    }

    const expected = new Set(request.messages.map((message) => message.customId));
    const parsed = new Map<string, MessageAnalysis>();
    for (const entry of results.results) {
      if (!entry || typeof entry !== "object" ||
          !hasExactKeys(entry as unknown as Record<string, unknown>, ["customId", "analysis"]) ||
          typeof entry.customId !== "string") {
        throw new Error("Manual analysis result item is invalid");
      }
      if (!expected.has(entry.customId) || parsed.has(entry.customId)) {
        throw new Error("Manual analysis result ids do not match the request");
      }
      parsed.set(entry.customId, parseManualAnalysis(entry.analysis));
    }
    if (parsed.size !== expected.size) throw new Error("Manual analysis results are incomplete");

    for (const [customId, analysis] of parsed) this.store.putBatchResult(batchId, customId, analysis);
    this.store.finishBatch(batchId, { succeeded: parsed.size, failed: 0 });
    unlinkSync(this.requestPath(batchId));
    return { imported: parsed.size };
  }

  private requestPath(batchId: string): string {
    if (!/^manual-[0-9a-f-]{36}$/.test(batchId)) throw new Error("Invalid manual analysis batch id");
    return join(this.queueDir, `${batchId}.json`);
  }
}
