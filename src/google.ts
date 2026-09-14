import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { google } from "googleapis";
import type { AppConfig } from "./config.js";
import type { SourceCalendarItem } from "./wilma.js";

const MANAGED_BY = "family-wilma-v1";

export class GoogleCalendarService {
  private readonly tokenPath: string;

  constructor(private readonly config: AppConfig) {
    mkdirSync(config.dataDir, { recursive: true });
    this.tokenPath = join(config.dataDir, "google-oauth-token.json");
  }

  authUrl(): string {
    return this.oauth().generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: ["https://www.googleapis.com/auth/calendar.events"],
    });
  }

  isConnected(): boolean {
    return Boolean(this.loadToken());
  }

  async handleCallback(code: string): Promise<void> {
    const client = this.oauth();
    const { tokens } = await client.getToken(code);
    writeFileSync(this.tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  }

  async sync(items: SourceCalendarItem[]): Promise<{ created: number; updated: number; unchanged: number }> {
    const token = this.loadToken();
    if (!token) throw new Error("Google Calendar is not connected");
    const auth = this.oauth();
    auth.setCredentials(token);
    auth.on("tokens", (tokens) => {
      const merged = { ...token, ...tokens };
      writeFileSync(this.tokenPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
    });
    const calendar = google.calendar({ version: "v3", auth });
    let created = 0;
    let updated = 0;
    let unchanged = 0;

    for (const item of items) {
      const desired = this.eventFor(item);
      const existing = await calendar.events.list({
        calendarId: this.config.googleCalendarId,
        privateExtendedProperty: [`familyWilmaSourceId=${item.sourceId}`],
        maxResults: 2,
        singleEvents: true,
      });
      const event = existing.data.items?.find(
        (candidate) => candidate.extendedProperties?.private?.familyWilmaManagedBy === MANAGED_BY,
      );
      if (!event?.id) {
        await calendar.events.insert({ calendarId: this.config.googleCalendarId, requestBody: desired });
        created += 1;
        continue;
      }
      if (this.sameEvent(event, desired)) {
        unchanged += 1;
        continue;
      }
      await calendar.events.update({
        calendarId: this.config.googleCalendarId,
        eventId: event.id,
        requestBody: desired,
      });
      updated += 1;
    }
    return { created, updated, unchanged };
  }

  private oauth() {
    return new google.auth.OAuth2(
      this.config.googleClientId,
      this.config.googleClientSecret,
      `${this.config.baseUrl}/oauth/google/callback`,
    );
  }

  private loadToken(): Record<string, unknown> | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.tokenPath, "utf8"));
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private eventFor(item: SourceCalendarItem) {
    const start = item.time ? { dateTime: `${item.date}T${item.time}:00`, timeZone: "Europe/Helsinki" } : { date: item.date };
    let end: { date?: string; dateTime?: string; timeZone?: string };
    if (item.time) {
      const startDate = new Date(`${item.date}T${item.time}:00+03:00`);
      const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
      end = { dateTime: endDate.toISOString(), timeZone: "Europe/Helsinki" };
    } else {
      const exclusiveEnd = new Date(`${item.endDate ?? item.date}T00:00:00Z`);
      exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
      end = { date: exclusiveEnd.toISOString().slice(0, 10) };
    }
    return {
      summary: item.title,
      description: item.description ?? undefined,
      start,
      end,
      extendedProperties: {
        private: {
          familyWilmaManagedBy: MANAGED_BY,
          familyWilmaSourceId: item.sourceId,
        },
      },
    };
  }

  private sameEvent(existing: { summary?: string | null; description?: string | null; start?: unknown; end?: unknown }, desired: ReturnType<GoogleCalendarService["eventFor"]>): boolean {
    return existing.summary === desired.summary
      && (existing.description ?? "") === (desired.description ?? "")
      && JSON.stringify(existing.start ?? {}) === JSON.stringify(desired.start)
      && JSON.stringify(existing.end ?? {}) === JSON.stringify(desired.end);
  }
}
