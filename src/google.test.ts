import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AppConfig } from "./config.js";
import { GoogleCalendarService, UnauthorizedGoogleAccountError } from "./google.js";
import type { SourceCalendarItem } from "./wilma.js";

function service() {
  const dataDir = mkdtempSync(join(tmpdir(), "family-wilma-google-"));
  const config: AppConfig = {
    port: 3000,
    host: "127.0.0.1",
    baseUrl: "http://localhost:3000",
    dataDir,
    anthropicApiKey: "test",
    googleClientId: "test",
    googleClientSecret: "test",
    googleAllowedEmail: "eero@example.com",
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
      endTime: "19:30",
      endDate: null,
      description: null,
    };
    const event = (calendar as unknown as { eventFor(item: SourceCalendarItem): { start: { dateTime?: string }; end: { dateTime?: string } } }).eventFor(item);
    assert.equal(event.start.dateTime, "2026-12-15T18:00:00");
    assert.equal(event.end.dateTime, "2026-12-15T19:30:00");
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

type FakeOauthClient = {
  getToken(code: string): Promise<{ tokens: Record<string, unknown> }>;
  getTokenInfo(accessToken: string): Promise<{ scopes: string[] }>;
  verifyIdToken(options: { idToken: string; audience: string }): Promise<{
    getPayload(): { email?: string; email_verified?: boolean } | undefined;
  }>;
};

test("allowed Google sign-in preserves an existing refresh token", async () => {
  const { calendar, dataDir } = service();
  try {
    const tokenPath = join(dataDir, "google-oauth-token.json");
    writeFileSync(tokenPath, JSON.stringify({
      refresh_token: "keep-me",
      access_token: "old",
      family_wilma_calendar_scope: "calendar.app.created",
    }));
    (calendar as unknown as { oauth: () => FakeOauthClient }).oauth = () => ({
      async getToken() {
        return { tokens: { id_token: "verified-id-token", access_token: "new" } };
      },
      async getTokenInfo() {
        return { scopes: ["https://www.googleapis.com/auth/calendar.app.created"] };
      },
      async verifyIdToken() {
        return { getPayload: () => ({ email: "EERO@EXAMPLE.COM", email_verified: true }) };
      },
    });

    assert.equal(await calendar.handleCallback("code"), "eero@example.com");
    assert.deepEqual(JSON.parse(readFileSync(tokenPath, "utf8")), {
      refresh_token: "keep-me",
      access_token: "new",
      id_token: "verified-id-token",
      family_wilma_calendar_scope: "calendar.app.created",
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Google sign-in is rejected when the calendar permission was not granted", async () => {
  const { calendar, dataDir } = service();
  try {
    (calendar as unknown as { oauth: () => FakeOauthClient }).oauth = () => ({
      async getToken() {
        return { tokens: { id_token: "verified-id-token", access_token: "new" } };
      },
      async getTokenInfo() {
        return { scopes: ["openid", "email"] };
      },
      async verifyIdToken() {
        return { getPayload: () => ({ email: "eero@example.com", email_verified: true }) };
      },
    });

    await assert.rejects(calendar.handleCallback("code"), /permission was not granted/);
    assert.equal(calendar.isConnected(), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("sync creates owned calendars, routes lessons separately, and removes stale lessons", async () => {
  const { calendar, dataDir } = service();
  const createdCalendars: string[] = [];
  const insertedEvents: Array<{ calendarId: string; summary: string }> = [];
  const deletedEvents: Array<{ calendarId: string; eventId: string }> = [];
  let calendarSequence = 0;
  const fakeApi = {
    calendars: {
      get: async () => ({ data: {} }),
      insert: async ({ requestBody }: { requestBody: { summary: string } }) => {
        createdCalendars.push(requestBody.summary);
        calendarSequence += 1;
        return { data: { id: `calendar-${calendarSequence}` } };
      },
    },
    events: {
      list: async ({ calendarId }: { calendarId: string }) => ({
        data: {
          items: calendarId === "calendar-2" ? [
            {
              id: "stale-lesson",
              summary: "Old lesson",
              start: { dateTime: "2026-09-16T08:00:00+03:00" },
              end: { dateTime: "2026-09-16T09:00:00+03:00" },
              extendedProperties: { private: {
                familyWilmaManagedBy: "family-wilma-v1",
                familyWilmaSourceId: "wilma-lesson:old",
              } },
            },
            {
              id: "past-lesson",
              summary: "Past lesson",
              start: { dateTime: "2026-09-14T08:00:00+03:00" },
              end: { dateTime: "2026-09-14T09:00:00+03:00" },
              extendedProperties: { private: {
                familyWilmaManagedBy: "family-wilma-v1",
                familyWilmaSourceId: "wilma-lesson:past",
              } },
            },
          ] : [],
        },
      }),
      insert: async ({ calendarId, requestBody }: { calendarId: string; requestBody: { summary: string } }) => {
        insertedEvents.push({ calendarId, summary: requestBody.summary });
      },
      update: async () => { throw new Error("unexpected update"); },
      delete: async ({ calendarId, eventId }: { calendarId: string; eventId: string }) => {
        deletedEvents.push({ calendarId, eventId });
      },
    },
  };

  try {
    writeFileSync(join(dataDir, "google-oauth-token.json"), JSON.stringify({
      access_token: "test",
      family_wilma_calendar_scope: "calendar.app.created",
    }));
    (calendar as unknown as { oauth: () => { setCredentials(value: unknown): void; on(): void } }).oauth = () => ({
      setCredentials() {},
      on() {},
    });
    (calendar as unknown as { api: () => unknown }).api = () => fakeApi;

    const result = await calendar.sync({
      sharedItems: [{
        sourceId: "wilma-exam:1", title: "Child: Exam", date: "2026-09-20",
        time: null, endDate: null, description: null,
      }],
      lessonCalendars: [{
        child: "Child",
        reconcile: true,
        items: [{
          sourceId: "wilma-lesson:1", title: "Math", date: "2026-09-16",
          time: "10:00", endTime: "11:30", endDate: null, description: null,
        }],
      }],
      lessonWindow: { start: "2026-09-14", end: "2027-03-15", deleteFrom: "2026-09-15" },
    });

    assert.deepEqual(createdCalendars, ["Family Wilma – yhteiset", "Child – Lukujärjestys"]);
    assert.deepEqual(insertedEvents, [
      { calendarId: "calendar-1", summary: "Child: Exam" },
      { calendarId: "calendar-2", summary: "Math" },
    ]);
    assert.deepEqual(deletedEvents, [{ calendarId: "calendar-2", eventId: "stale-lesson" }]);
    assert.deepEqual(result, { created: 2, updated: 0, unchanged: 0, deleted: 1 });

    const persisted = JSON.parse(readFileSync(join(dataDir, "google-calendar-map.json"), "utf8"));
    assert.equal(persisted.shared, "calendar-1");
    assert.equal(persisted.lessons.Child, "calendar-2");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("sync fails closed on a corrupt calendar map", async () => {
  const { calendar, dataDir } = service();
  let created = 0;
  try {
    writeFileSync(join(dataDir, "google-oauth-token.json"), JSON.stringify({
      access_token: "test",
      family_wilma_calendar_scope: "calendar.app.created",
    }));
    writeFileSync(join(dataDir, "google-calendar-map.json"), "{");
    (calendar as unknown as { oauth: () => { setCredentials(value: unknown): void; on(): void } }).oauth = () => ({
      setCredentials() {},
      on() {},
    });
    (calendar as unknown as { api: () => unknown }).api = () => ({
      calendars: { insert: async () => { created += 1; return { data: { id: "unexpected" } }; } },
    });

    await assert.rejects(calendar.sync({
      sharedItems: [], lessonCalendars: [],
      lessonWindow: { start: "2026-09-14", end: "2027-03-15", deleteFrom: "2026-09-15" },
    }), SyntaxError);
    assert.equal(created, 0);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("sync recreates confirmed deleted mapped calendars", async () => {
  const { calendar, dataDir } = service();
  const created: string[] = [];
  try {
    writeFileSync(join(dataDir, "google-oauth-token.json"), JSON.stringify({
      access_token: "test",
      family_wilma_calendar_scope: "calendar.app.created",
    }));
    writeFileSync(join(dataDir, "google-calendar-map.json"), JSON.stringify({
      shared: "deleted-shared",
      lessons: { Child: "deleted-child" },
      provisioning: null,
    }));
    (calendar as unknown as { oauth: () => { setCredentials(value: unknown): void; on(): void } }).oauth = () => ({
      setCredentials() {},
      on() {},
    });
    (calendar as unknown as { api: () => unknown }).api = () => ({
      calendars: {
        get: async () => { throw { status: 404 }; },
        insert: async ({ requestBody }: { requestBody: { summary: string } }) => {
          created.push(requestBody.summary);
          return { data: { id: `new-${created.length}` } };
        },
      },
      events: {
        list: async () => ({ data: { items: [{
          id: "preserved",
          start: { dateTime: "2026-09-16T08:00:00+03:00" },
          extendedProperties: { private: { familyWilmaSourceId: "wilma-lesson:preserved" } },
        }] } }),
        delete: async () => { throw new Error("unsafe deletion"); },
      },
    });

    await calendar.sync({
      sharedItems: [],
      lessonCalendars: [{ child: "Child", items: [], reconcile: false }],
      lessonWindow: { start: "2026-09-14", end: "2027-03-15", deleteFrom: "2026-09-15" },
    });
    assert.deepEqual(created, ["Family Wilma – yhteiset", "Child – Lukujärjestys"]);
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, "google-calendar-map.json"), "utf8")), {
      shared: "new-1", lessons: { Child: "new-2" }, provisioning: null,
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("an uncertain calendar creation is not retried automatically", async () => {
  const { calendar, dataDir } = service();
  let attempts = 0;
  try {
    writeFileSync(join(dataDir, "google-oauth-token.json"), JSON.stringify({
      access_token: "test",
      family_wilma_calendar_scope: "calendar.app.created",
    }));
    (calendar as unknown as { oauth: () => { setCredentials(value: unknown): void; on(): void } }).oauth = () => ({
      setCredentials() {},
      on() {},
    });
    (calendar as unknown as { api: () => unknown }).api = () => ({
      calendars: {
        insert: async () => { attempts += 1; throw new Error("connection lost"); },
      },
    });
    const plan = {
      sharedItems: [], lessonCalendars: [],
      lessonWindow: { start: "2026-09-14", end: "2027-03-15", deleteFrom: "2026-09-15" },
    };

    await assert.rejects(calendar.sync(plan), /connection lost/);
    await assert.rejects(calendar.sync(plan), /uncertain result/);
    assert.equal(attempts, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, "google-calendar-map.json"), "utf8")).provisioning, { kind: "shared" });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("disallowed Google sign-in cannot overwrite Calendar credentials", async () => {
  const { calendar, dataDir } = service();
  try {
    const tokenPath = join(dataDir, "google-oauth-token.json");
    const original = JSON.stringify({ refresh_token: "keep-me", access_token: "old" });
    writeFileSync(tokenPath, original);
    (calendar as unknown as { oauth: () => FakeOauthClient }).oauth = () => ({
      async getToken() {
        return { tokens: { id_token: "verified-id-token", access_token: "attacker" } };
      },
      async getTokenInfo() {
        return { scopes: ["https://www.googleapis.com/auth/calendar.app.created"] };
      },
      async verifyIdToken() {
        return { getPayload: () => ({ email: "attacker@example.com", email_verified: true }) };
      },
    });

    await assert.rejects(calendar.handleCallback("code"), UnauthorizedGoogleAccountError);
    assert.equal(readFileSync(tokenPath, "utf8"), original);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
