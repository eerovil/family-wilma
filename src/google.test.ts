import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AppConfig } from "./config.js";
import { GoogleCalendarService } from "./google.js";
import type { SourceCalendarItem } from "./wilma.js";

function service() {
  const dataDir = mkdtempSync(join(tmpdir(), "family-wilma-google-"));
  const config: AppConfig = {
    port: 3000,
    baseUrl: "http://localhost:3000",
    dataDir,
    anthropicApiKey: "test",
    googleClientId: "test",
    googleClientSecret: "test",
    googleCalendarId: "primary",
    wilmaAccounts: [],
  };
  return { calendar: new GoogleCalendarService(config), dataDir };
}

test("timed events stay one hour long across Helsinki winter time", () => {
  const { calendar, dataDir } = service();
  try {
    const item: SourceCalendarItem = {
      sourceId: "test:winter",
      title: "Winter event",
      date: "2026-12-15",
      time: "18:00",
      endDate: null,
      description: null,
    };
    const event = (calendar as unknown as { eventFor(item: SourceCalendarItem): { start: { dateTime?: string }; end: { dateTime?: string } } }).eventFor(item);
    assert.equal(event.start.dateTime, "2026-12-15T18:00:00");
    assert.equal(event.end.dateTime, "2026-12-15T19:00:00");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Google offset timestamps compare equal to the desired Helsinki wall time", () => {
  const { calendar, dataDir } = service();
  try {
    const item: SourceCalendarItem = {
      sourceId: "test:summer",
      title: "Summer event",
      date: "2026-06-15",
      time: "18:00",
      endDate: null,
      description: "Description",
    };
    type Desired = {
      summary: string;
      description?: string;
      start: { date?: string; dateTime?: string; timeZone?: string };
      end: { date?: string; dateTime?: string; timeZone?: string };
    };
    const internals = calendar as unknown as {
      eventFor(item: SourceCalendarItem): Desired;
      sameEvent(existing: {
        summary?: string | null;
        description?: string | null;
        start?: { date?: string | null; dateTime?: string | null } | null;
        end?: { date?: string | null; dateTime?: string | null } | null;
      }, desired: Desired): boolean;
    };
    const desired = internals.eventFor(item);
    assert.equal(internals.sameEvent({
      summary: "Summer event",
      description: "Description",
      start: { dateTime: "2026-06-15T18:00:00+03:00" },
      end: { dateTime: "2026-06-15T19:00:00+03:00" },
    }, desired), true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
