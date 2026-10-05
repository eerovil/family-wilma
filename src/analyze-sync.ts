import type { AnalysisBatchStatus, LastCalendarSync, SyncErrorCategory } from "./store.js";
import type { CalendarSyncResult } from "./google.js";
import type { FetchedMessage } from "./wilma.js";

export interface AnalyzeSyncSnapshot {
  state: "idle" | "analyzing" | "syncing" | "mfa" | "success" | "error";
  result: CalendarSyncResult | null;
  error: string | null;
  mfaAccountId: string | null;
  finishedAt: string | null;
}

export const SYNC_ERROR_MESSAGES: Record<SyncErrorCategory, string> = {
  analysis_failed: "Viestien analysointi epäonnistui. Yritä uudelleen.",
  wilma_failed: "Wilman tietojen haku epäonnistui. Yritä uudelleen.",
  google_not_connected: "Google Calendaria ei ole yhdistetty. Kalenterin omistajan pitää yhdistää se.",
  google_login_expired: "Google Calendarin kirjautuminen on vanhentunut. Kalenterin omistajan pitää yhdistää Google Calendar uudelleen.",
  google_failed: "Google Calendar hylkäsi synkronoinnin. Yritä uudelleen.",
};

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
  /** Names a calendar-step failure; anything it does not name is blamed on Wilma. */
  errorCategory?(error: unknown): SyncErrorCategory | null;
  /** Keeps the finished outcome, so the page can show it after the banner and after a restart. */
  saveResult?(sync: LastCalendarSync): void;
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
    let phase: "analysis" | "sync" = "analysis";
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
      phase = "sync";
      await this.dependencies.waitForWilmaTurn?.();
      this.status = { ...this.status, state: "syncing" };
      const result = await this.dependencies.sync();
      const finishedAt = this.now();
      this.status = { state: "success", result, error: null, mfaAccountId: null, finishedAt };
      this.dependencies.log?.(`calendar sync done: created ${result.created}, updated ${result.updated}, deleted ${result.deleted}, unchanged ${result.unchanged}, skipped ${result.skipped}`);
      this.dependencies.saveResult?.({ finishedAt, state: "success", result: { ...result }, errorCategory: null });
    } catch (error) {
      const mfaAccountId = this.dependencies.mfaAccountId?.(error) ?? null;
      if (mfaAccountId) {
        this.status = { state: "mfa", result: null, error: null, mfaAccountId, finishedAt: null };
        return;
      }
      this.dependencies.reportError?.(error);
      const category = phase === "analysis"
        ? "analysis_failed"
        : this.dependencies.errorCategory?.(error) ?? "wilma_failed";
      const finishedAt = this.now();
      this.status = {
        state: "error",
        result: null,
        error: SYNC_ERROR_MESSAGES[category],
        mfaAccountId: null,
        finishedAt,
      };
      this.dependencies.log?.(`calendar sync failed: ${category}`);
      this.dependencies.saveResult?.({ finishedAt, state: "error", result: null, errorCategory: category });
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
