const HOUR_MS = 60 * 60 * 1_000;

export interface BackgroundRefreshStep {
  name: string;
  /** Runs one refresh to completion. Resolves to "mfa" when Wilma asked for a login code and the step was skipped. */
  run(): Promise<"done" | "mfa">;
}

interface BackgroundRefreshDependencies {
  intervalHours: number;
  steps: BackgroundRefreshStep[];
  /** The oldest saved-at time among the refreshed snapshots, or null when one has never been saved. */
  oldestUpdatedAt(): string | null;
  reportError(error: unknown, step: string): void;
  log?: (line: string) => void;
  now?: () => Date;
  setInterval?: (run: () => void, ms: number) => { unref?: () => void };
}

/**
 * Refreshes messages, homework and the school mornings on a timer so the saved
 * views, and Home Assistant's dawn light, stay current without anyone opening
 * the app. Steps run one after another so Wilma never sees two logins at once.
 * It never starts AI analysis or calendar sync: those cost money or write to
 * Google and stay behind their buttons.
 */
export class BackgroundRefresh {
  private running: Promise<void> | null = null;

  constructor(private readonly dependencies: BackgroundRefreshDependencies) {}

  /** Starts the timer, and one run right away when the saved data is older than the interval. Off at 0 hours. */
  start(): boolean {
    const { intervalHours } = this.dependencies;
    if (intervalHours <= 0) return false;
    const intervalMs = intervalHours * HOUR_MS;
    const timer = (this.dependencies.setInterval ?? setInterval)(() => { void this.runOnce(); }, intervalMs);
    timer.unref?.();
    if (this.isStale(intervalMs)) void this.runOnce();
    return true;
  }

  /** One full refresh. A run already in progress is joined, not started twice. */
  runOnce(): Promise<void> {
    if (!this.running) this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }

  private async run(): Promise<void> {
    for (const step of this.dependencies.steps) {
      try {
        const result = await step.run();
        if (result === "mfa") {
          this.dependencies.reportError(new Error(`Background refresh skipped ${step.name}: Wilma asked for a login code`), step.name);
        }
      } catch (error) {
        this.dependencies.reportError(error, step.name);
      }
    }
    this.dependencies.log?.("background refresh finished");
  }

  private isStale(intervalMs: number): boolean {
    const oldest = this.dependencies.oldestUpdatedAt();
    if (!oldest) return true;
    const savedAt = new Date(oldest).getTime();
    const now = (this.dependencies.now?.() ?? new Date()).getTime();
    return !Number.isFinite(savedAt) || now - savedAt >= intervalMs;
  }
}
