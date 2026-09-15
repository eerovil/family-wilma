import type { MessageAnalysis } from "./store.js";
import type { FetchedMessage, WilmaBundle } from "./wilma.js";

const RECENT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1_000;

export interface AnalyzedMessage {
  message: FetchedMessage;
  calendarItems: MessageAnalysis["calendarItems"];
  hasOtherContent: boolean;
  cached: boolean;
}

export interface MessageLoadSnapshot {
  state: "idle" | "fetching" | "analyzing" | "mfa" | "ready" | "error";
  includeOlder: boolean;
  completed: number;
  total: number;
  messages: AnalyzedMessage[];
  error: string | null;
  mfaAccountId: string | null;
  queuedIncludeOlder: boolean;
}

interface MessageLoadDependencies {
  fetch(options: { sentAfter?: Date }): Promise<WilmaBundle>;
  analyze(message: FetchedMessage): Promise<{ analysis: MessageAnalysis; cached: boolean }>;
  mfaAccountId?(error: unknown): string | null;
  now?: () => Date;
}

export class MessageLoadJob {
  private current: Promise<void> | null = null;
  private status: MessageLoadSnapshot = {
    state: "idle",
    includeOlder: false,
    completed: 0,
    total: 0,
    messages: [],
    error: null,
    mfaAccountId: null,
    queuedIncludeOlder: false,
  };

  constructor(private readonly dependencies: MessageLoadDependencies) {}

  start(options: { includeOlder: boolean }): void {
    if (this.current) {
      if (options.includeOlder && !this.status.includeOlder) {
        this.status.queuedIncludeOlder = true;
      }
      return;
    }
    this.status = {
      state: "fetching",
      includeOlder: options.includeOlder,
      completed: 0,
      total: 0,
      messages: [],
      error: null,
      mfaAccountId: null,
      queuedIncludeOlder: false,
    };
    this.current = this.run(options).finally(() => {
      const startOlder = this.status.queuedIncludeOlder && !options.includeOlder;
      this.current = null;
      if (startOlder) this.start({ includeOlder: true });
    });
  }

  snapshot(): MessageLoadSnapshot {
    return { ...this.status, messages: [...this.status.messages] };
  }

  async wait(): Promise<void> {
    await this.current;
  }

  claimMfa(accountId: string): boolean {
    if (this.current || this.status.state !== "mfa" || this.status.mfaAccountId !== accountId) return false;
    this.status = { ...this.status, state: "idle", mfaAccountId: null };
    return true;
  }

  private async run(options: { includeOlder: boolean }): Promise<void> {
    try {
      const now = this.dependencies.now?.() ?? new Date();
      const fetchOptions = options.includeOlder
        ? {}
        : { sentAfter: new Date(now.getTime() - RECENT_DAYS * DAY_MS) };
      const bundle = await this.dependencies.fetch(fetchOptions);
      this.status = { ...this.status, state: "analyzing", total: bundle.messages.length };
      for (const message of bundle.messages) {
        const analyzed = await this.dependencies.analyze(message);
        this.status.messages.push({
          message,
          calendarItems: analyzed.analysis.calendarItems,
          hasOtherContent: analyzed.analysis.hasOtherContent,
          cached: analyzed.cached,
        });
        this.status.completed += 1;
      }
      this.status = { ...this.status, state: "ready" };
    } catch (error) {
      const mfaAccountId = this.dependencies.mfaAccountId?.(error) ?? null;
      if (mfaAccountId) {
        this.status = { ...this.status, state: "mfa", mfaAccountId };
        return;
      }
      console.error(`message loading failed: ${error instanceof Error ? error.name : "Error"}`);
      this.status = { ...this.status, state: "error", error: "Viestien lataaminen epäonnistui." };
    }
  }
}
