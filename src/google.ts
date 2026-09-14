import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { google } from "googleapis";
import type { AppConfig } from "./config.js";
import type { SourceCalendarItem } from "./wilma.js";

const MANAGED_BY = "family-wilma-v1";
const HELSINKI_TIME_ZONE = "Europe/Helsinki";

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
    const start = item.time
      ? { dateTime: `${item.date}T${item.time}:00`, timeZone: HELSINKI_TIME_ZONE }
      : { date: item.date };
    let end: { date?: string; dateTime?: string; timeZone?: string };
    if (item.time) {
      end = {
        dateTime: addOneHourToLocalDateTime(item.date, item.time),
        timeZone: HELSINKI_TIME_ZONE,
      };
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

  private sameEvent(
    existing: {
      summary?: string | null;
      description?: string | null;
      start?: { date?: string | null; dateTime?: string | null } | null;
      end?: { date?: string | null; dateTime?: string | null } | null;
    },
    desired: ReturnType<GoogleCalendarService["eventFor"]>,
  ): boolean {
    if (existing.summary !== desired.summary || (existing.description ?? "") !== (desired.description ?? "")) {
      return false;
    }
    if (desired.start.date) {
      return existing.start?.date === desired.start.date && existing.end?.date === desired.end.date;
    }
    return localHelsinkiDateTime(existing.start?.dateTime) === desired.start.dateTime
      && localHelsinkiDateTime(existing.end?.dateTime) === desired.end.dateTime;
  }
}

function addOneHourToLocalDateTime(date: string, time: string): string {
  const naive = new Date(`${date}T${time}:00Z`);
  if (Number.isNaN(naive.getTime())) throw new Error(`Invalid calendar time: ${date} ${time}`);
  naive.setUTCHours(naive.getUTCHours() + 1);
  return naive.toISOString().slice(0, 19);
}

function localHelsinkiDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: HELSINKI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;
}
