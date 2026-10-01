import type { AnalysisBatchStatus } from "./store.js";
import type { CalendarSyncResult } from "./google.js";
import type { FetchedMessage } from "./wilma.js";

export interface AnalyzeSyncSnapshot {
  state: "idle" | "analyzing" | "syncing" | "mfa" | "success" | "error";
  result: CalendarSyncResult | null;
  error: string | null;
  mfaAccountId: string | null;
  finishedAt: string | null;
}

interface AnalyzeSyncDependencies {
  submit(messages: FetchedMessage[]): Promise<unknown>;
  refresh(): Promise<void>;
  pending(message: FetchedMessage): boolean;
  statuses(): AnalysisBatchStatus[];
  sync(): Promise<CalendarSyncResult>;
  /** Resolves when no other job is reading Wilma; the batch itself never touches Wilma. */
  waitForWilmaTurn?(): Promise<void>;
  /** Receives one line per finished batch, for the server log. */
  log?(line: string): void;
  pause?(): Promise<void>;
  mfaAccountId?(error: unknown): string | null;
  reportError?(error: unknown): void;
  now?(): Date;
}

export class AnalyzeSyncJob {
  private current: Promise<void> | null = null;
  private status: AnalyzeSyncSnapshot = {
    state: "idle",
    result: null,
    error: null,
    mfaAccountId: null,
    finishedAt: null,
  };

  constructor(private readonly dependencies: AnalyzeSyncDependencies) {}

  start(messages: FetchedMessage[]): boolean {
    if (this.current || this.status.state === "mfa") return false;
    const copy = [...messages];
    this.status = {
      state: copy.length ? "analyzing" : "syncing",
      result: null,
      error: null,
      mfaAccountId: null,
      finishedAt: null,
    };
    this.current = this.run(copy).finally(() => { this.current = null; });
    return true;
  }

  snapshot(): AnalyzeSyncSnapshot {
    return { ...this.status, result: this.status.result ? { ...this.status.result } : null };
  }

  async wait(): Promise<void> {
    await this.current;
  }

  claimMfa(accountId: string): boolean {
    if (this.current || this.status.state !== "mfa" || this.status.mfaAccountId !== accountId) return false;
    this.status = { state: "idle", result: null, error: null, mfaAccountId: null, finishedAt: null };
    return true;
  }

  private async run(messages: FetchedMessage[]): Promise<void> {
    try {
      if (messages.length) {
        const started = Date.now();
        await this.dependencies.submit(messages);
        while (messages.some((message) => this.dependencies.pending(message))) {
          if (this.dependencies.statuses().some((status) => status.status === "submitting")) {
            throw new Error("Analysis submission state is uncertain");
          }
          await this.dependencies.refresh();
          if (messages.some((message) => this.dependencies.pending(message))) {
            await (this.dependencies.pause?.() ?? new Promise((resolve) => setTimeout(resolve, 5_000)));
          }
        }
        this.dependencies.log?.(`analysis batch ${formatDuration(Date.now() - started)} (${messages.length} messages)`);
      }
      await this.dependencies.waitForWilmaTurn?.();
      this.status = { ...this.status, state: "syncing" };
      const result = await this.dependencies.sync();
      this.status = { state: "success", result, error: null, mfaAccountId: null, finishedAt: this.now() };
    } catch (error) {
      const mfaAccountId = this.dependencies.mfaAccountId?.(error) ?? null;
      if (mfaAccountId) {
        this.status = { state: "mfa", result: null, error: null, mfaAccountId, finishedAt: null };
        return;
      }
      this.dependencies.reportError?.(error);
      this.status = {
        state: "error",
        result: null,
        error: "Analysointi tai kalenterin synkronointi epäonnistui. Yritä uudelleen.",
        mfaAccountId: null,
        finishedAt: this.now(),
      };
    }
  }

  private now(): string {
    return (this.dependencies.now?.() ?? new Date()).toISOString();
  }
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return minutes < 60 ? `${minutes}m${seconds}s` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}
