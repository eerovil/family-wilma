import type { AnalysisBatchStatus } from "./store.js";
import type { CalendarSyncResult } from "./google.js";
import type { FetchedMessage } from "./wilma.js";

export interface AnalyzeSyncSnapshot {
  state: "idle" | "analyzing" | "syncing" | "mfa" | "success" | "error";
  result: CalendarSyncResult | null;
  error: string | null;
  mfaAccountId: string | null;
}

interface AnalyzeSyncDependencies {
  submit(messages: FetchedMessage[]): Promise<unknown>;
  refresh(): Promise<void>;
  pending(message: FetchedMessage): boolean;
  statuses(): AnalysisBatchStatus[];
  sync(): Promise<CalendarSyncResult>;
  pause?(): Promise<void>;
  mfaAccountId?(error: unknown): string | null;
  reportError?(error: unknown): void;
}

export class AnalyzeSyncJob {
  private current: Promise<void> | null = null;
  private status: AnalyzeSyncSnapshot = {
    state: "idle",
    result: null,
    error: null,
    mfaAccountId: null,
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
    this.status = { state: "idle", result: null, error: null, mfaAccountId: null };
    return true;
  }

  private async run(messages: FetchedMessage[]): Promise<void> {
    try {
      if (messages.length) {
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
      }
      this.status = { ...this.status, state: "syncing" };
      const result = await this.dependencies.sync();
      this.status = { state: "success", result, error: null, mfaAccountId: null };
    } catch (error) {
      const mfaAccountId = this.dependencies.mfaAccountId?.(error) ?? null;
      if (mfaAccountId) {
        this.status = { state: "mfa", result: null, error: null, mfaAccountId };
        return;
      }
      this.dependencies.reportError?.(error);
      this.status = {
        state: "error",
        result: null,
        error: "Analysointi tai kalenterin synkronointi epäonnistui. Yritä uudelleen.",
        mfaAccountId: null,
      };
    }
  }
}
