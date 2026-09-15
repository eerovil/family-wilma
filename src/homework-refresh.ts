import { randomUUID } from "node:crypto";
import { cacheIsFresh } from "./cache-freshness.js";
import type { HomeworkCacheStore } from "./homework-cache.js";
import type { PedanetHomework } from "./pedanet-homework.js";
import type { FetchedHomework } from "./wilma.js";

export interface HomeworkRefreshSnapshot {
  state: "idle" | "running" | "mfa" | "success" | "error";
  runId: string | null;
  homework: FetchedHomework[];
  wilmaUpdatedAt: string | null;
  wilmaError: boolean;
  pedanet: PedanetHomework[];
  pedanetUpdatedAt: string | null;
  pedanetError: boolean;
  mfaAccountId: string | null;
}

interface HomeworkRefreshDependencies {
  cache: HomeworkCacheStore;
  waitForWilmaTurn?: () => Promise<void>;
  fetchWilma(): Promise<FetchedHomework[]>;
  fetchPedanet?: () => Promise<PedanetHomework[]>;
  mfaAccountId?(error: unknown): string | null;
  reportError?(error: unknown, source: "wilma" | "pedanet"): void;
  now?: () => Date;
}

export class HomeworkRefreshJob {
  private current: Promise<void> | null = null;
  private status: HomeworkRefreshSnapshot;

  constructor(private readonly dependencies: HomeworkRefreshDependencies) {
    const wilma = dependencies.cache.getWilma();
    const pedanet = dependencies.cache.getPedanet();
    this.status = {
      state: "idle",
      runId: null,
      homework: wilma?.value ?? [],
      wilmaUpdatedAt: wilma?.updatedAt ?? null,
      wilmaError: false,
      pedanet: pedanet?.value ?? [],
      pedanetUpdatedAt: pedanet?.updatedAt ?? null,
      pedanetError: false,
      mfaAccountId: null,
    };
  }

  needsRefresh(): boolean {
    const now = this.dependencies.now?.() ?? new Date();
    return !cacheIsFresh(this.status.wilmaUpdatedAt, now)
      || Boolean(this.dependencies.fetchPedanet && !cacheIsFresh(this.status.pedanetUpdatedAt, now));
  }

  start(options: { force?: boolean } = { force: true }): string | null {
    const force = options.force ?? false;
    if (this.current) return this.status.runId ?? "pending";
    if (this.status.state === "mfa") return this.status.runId ?? "pending";
    const now = this.dependencies.now?.() ?? new Date();
    const refreshWilma = force || !cacheIsFresh(this.status.wilmaUpdatedAt, now);
    const refreshPedanet = Boolean(this.dependencies.fetchPedanet)
      && (force || !cacheIsFresh(this.status.pedanetUpdatedAt, now));
    if (!refreshWilma && !refreshPedanet) return null;
    const runId = randomUUID();
    this.status = {
      ...this.status,
      state: "running",
      runId,
      wilmaError: false,
      pedanetError: false,
      mfaAccountId: null,
    };
    this.current = this.run(refreshWilma, refreshPedanet).finally(() => { this.current = null; });
    return runId;
  }

  snapshot(): HomeworkRefreshSnapshot {
    return { ...this.status, homework: [...this.status.homework], pedanet: [...this.status.pedanet] };
  }

  async wait(): Promise<void> {
    await this.current;
  }

  claimMfa(accountId: string): boolean {
    if (this.current || this.status.state !== "mfa" || this.status.mfaAccountId !== accountId) return false;
    this.status = { ...this.status, state: "idle", mfaAccountId: null };
    return true;
  }

  private async run(refreshWilma: boolean, refreshPedanet: boolean): Promise<void> {
    await Promise.all([
      refreshWilma ? this.refreshWilma() : Promise.resolve(),
      refreshPedanet ? this.refreshPedanet() : Promise.resolve(),
    ]);
    this.status = {
      ...this.status,
      state: this.status.mfaAccountId ? "mfa" : this.status.wilmaError || this.status.pedanetError ? "error" : "success",
    };
  }

  private async refreshWilma(): Promise<void> {
    try {
      await this.dependencies.waitForWilmaTurn?.();
      const homework = await this.dependencies.fetchWilma();
      const updatedAt = this.updatedAt();
      this.dependencies.cache.putWilma(homework, updatedAt);
      this.status = { ...this.status, homework, wilmaUpdatedAt: updatedAt };
    } catch (error) {
      const mfaAccountId = this.dependencies.mfaAccountId?.(error) ?? null;
      if (mfaAccountId) {
        this.status = { ...this.status, mfaAccountId };
      } else {
        this.status = { ...this.status, wilmaError: true };
        this.dependencies.reportError?.(error, "wilma");
      }
    }
  }

  private async refreshPedanet(): Promise<void> {
    if (!this.dependencies.fetchPedanet) return;
    try {
      const pedanet = await this.dependencies.fetchPedanet();
      const updatedAt = this.updatedAt();
      this.dependencies.cache.putPedanet(pedanet, updatedAt);
      this.status = { ...this.status, pedanet, pedanetUpdatedAt: updatedAt };
    } catch (error) {
      this.status = { ...this.status, pedanetError: true };
      this.dependencies.reportError?.(error, "pedanet");
    }
  }

  private updatedAt(): string {
    return (this.dependencies.now?.() ?? new Date()).toISOString();
  }
}
