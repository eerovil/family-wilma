import type { CalendarSyncResult } from "./google.js";

export interface CalendarSyncSnapshot {
  state: "idle" | "running" | "mfa" | "success" | "error";
  result: CalendarSyncResult | null;
  error: string | null;
  mfaAccountId: string | null;
}

interface CalendarSyncDependencies {
  sync(): Promise<CalendarSyncResult>;
  mfaAccountId?(error: unknown): string | null;
  reportError?(error: unknown): void;
}

export class CalendarSyncJob {
  private current: Promise<void> | null = null;
  private status: CalendarSyncSnapshot = {
    state: "idle",
    result: null,
    error: null,
    mfaAccountId: null,
  };

  constructor(private readonly dependencies: CalendarSyncDependencies) {}

  start(): boolean {
    if (this.current) return false;
    this.status = { state: "running", result: null, error: null, mfaAccountId: null };
    this.current = this.run().finally(() => { this.current = null; });
    return true;
  }

  snapshot(): CalendarSyncSnapshot {
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

  private async run(): Promise<void> {
    try {
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
        error: "Kalenterin synkronointi epäonnistui. Yritä uudelleen.",
        mfaAccountId: null,
      };
    }
  }
}
