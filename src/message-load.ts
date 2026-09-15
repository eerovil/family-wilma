import { cacheIsFresh } from "./cache-freshness.js";
import type { MessageCacheStore } from "./message-cache.js";
import type { FetchedMessage, WilmaBundle } from "./wilma.js";

const RECENT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1_000;

export interface MessageLoadSnapshot {
  state: "idle" | "fetching" | "mfa" | "ready" | "error";
  messages: FetchedMessage[];
  structuredCalendarItems: WilmaBundle["structuredCalendarItems"];
  updatedAt: string | null;
  error: string | null;
  mfaAccountId: string | null;
}

interface MessageLoadDependencies {
  cache: MessageCacheStore;
  fetch(options: { sentAfter: Date }): Promise<WilmaBundle>;
  mfaAccountId?(error: unknown): string | null;
  reportError?(error: unknown): void;
  now?: () => Date;
}

export class MessageLoadJob {
  private current: Promise<void> | null = null;
  private status: MessageLoadSnapshot;

  constructor(private readonly dependencies: MessageLoadDependencies) {
    const cached = dependencies.cache.get();
    this.status = {
      state: cached ? "ready" : "idle",
      messages: cached?.messages ?? [],
      structuredCalendarItems: cached?.structuredCalendarItems ?? [],
      updatedAt: cached?.updatedAt ?? null,
      error: null,
      mfaAccountId: null,
    };
  }

  needsRefresh(): boolean {
    return !cacheIsFresh(this.status.updatedAt, this.now());
  }

  start(options: { force?: boolean } = {}): boolean {
    if (this.current || this.status.state === "mfa") return false;
    if (!options.force && !this.needsRefresh()) return false;
    this.status = { ...this.status, state: "fetching", error: null, mfaAccountId: null };
    this.current = this.run().finally(() => { this.current = null; });
    return true;
  }

  snapshot(): MessageLoadSnapshot {
    return {
      ...this.status,
      messages: [...this.status.messages],
      structuredCalendarItems: [...this.status.structuredCalendarItems],
    };
  }

  async wait(): Promise<void> {
    await this.current;
  }

  claimMfa(accountId: string): boolean {
    if (this.current || this.status.state !== "mfa" || this.status.mfaAccountId !== accountId) return false;
    this.status = { ...this.status, state: this.status.updatedAt ? "ready" : "idle", mfaAccountId: null };
    return true;
  }

  private async run(): Promise<void> {
    try {
      const now = this.now();
      const bundle = await this.dependencies.fetch({ sentAfter: new Date(now.getTime() - RECENT_DAYS * DAY_MS) });
      const updatedAt = this.now().toISOString();
      this.dependencies.cache.put(bundle, updatedAt);
      this.status = {
        ...this.status,
        state: "ready",
        messages: bundle.messages,
        structuredCalendarItems: bundle.structuredCalendarItems,
        updatedAt,
      };
    } catch (error) {
      const mfaAccountId = this.dependencies.mfaAccountId?.(error) ?? null;
      if (mfaAccountId) {
        this.status = { ...this.status, state: "mfa", mfaAccountId };
        return;
      }
      if (this.dependencies.reportError) this.dependencies.reportError(error);
      else console.error(`message loading failed: ${error instanceof Error ? error.name : "Error"}`);
      this.status = { ...this.status, state: "error", error: "Viestien päivittäminen epäonnistui." };
    }
  }

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }
}
