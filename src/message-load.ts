import type { FetchedMessage, WilmaBundle } from "./wilma.js";

const RECENT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1_000;

export interface MessageLoadSnapshot {
  state: "idle" | "fetching" | "mfa" | "ready" | "error";
  includeOlder: boolean;
  messages: FetchedMessage[];
  structuredCalendarItems: WilmaBundle["structuredCalendarItems"];
  error: string | null;
  mfaAccountId: string | null;
  queuedIncludeOlder: boolean;
}

interface MessageLoadDependencies {
  fetch(options: { sentAfter?: Date }): Promise<WilmaBundle>;
  mfaAccountId?(error: unknown): string | null;
  now?: () => Date;
}

export class MessageLoadJob {
  private current: Promise<void> | null = null;
  private status: MessageLoadSnapshot = {
    state: "idle",
    includeOlder: false,
    messages: [],
    structuredCalendarItems: [],
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
      messages: [],
      structuredCalendarItems: [],
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
      this.status = {
        ...this.status,
        state: "ready",
        messages: bundle.messages,
        structuredCalendarItems: bundle.structuredCalendarItems,
      };
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
