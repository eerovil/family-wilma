import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { calendar as calendarApi, calendar_v3 } from "@googleapis/calendar";
import { OAuth2Client } from "google-auth-library";
import type { AppConfig } from "./config.js";
import type { OAuthPurpose } from "./auth.js";
import type { LessonCalendar, LessonWindow, SourceCalendarItem } from "./wilma.js";

const MANAGED_BY = "family-wilma-v1";
const HELSINKI_TIME_ZONE = "Europe/Helsinki";
const APP_CREATED_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
const ACL_SCOPE = "https://www.googleapis.com/auth/calendar.acls";
const SCOPE_MARKER = "calendar.app.created+calendar.acls";
const WRITE_INTERVAL_MS = 250;
const MAX_RATE_LIMIT_RETRIES = 5;

export interface CalendarSyncPlan {
  sharedItems: SourceCalendarItem[];
  sharedSupersededSourcePrefixes?: string[];
  /** Source ids the household unchecked: never written, and deleted if already there. */
  droppedSourceIds?: string[];
  lessonCalendars: LessonCalendar[];
  lessonWindow: LessonWindow;
}

export interface CalendarSyncResult {
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  /** Items Google refused or that could not be turned into an event; the rest still sync. */
  skipped: number;
}

export type CalendarSyncErrorCategory = "google_not_connected" | "google_login_expired" | "google_failed";

/** A failure inside the Google step, labelled so the page can say what went wrong. */
export class CalendarSyncError extends Error {
  readonly status?: number;
  readonly code?: unknown;

  constructor(readonly category: CalendarSyncErrorCategory, cause: Error) {
    super(cause.message, { cause });
    this.name = "CalendarSyncError";
    const status = httpStatus(cause);
    if (status !== undefined) this.status = status;
    if (cause && typeof cause === "object" && "code" in cause) this.code = (cause as { code?: unknown }).code;
  }
}

const googleStepFailures = new WeakSet<object>();

/** Which part of the Google step failed, or null when the error came from elsewhere. */
export function calendarSyncErrorCategory(error: unknown): CalendarSyncErrorCategory | null {
  if (error instanceof CalendarSyncError) return error.category;
  return error && typeof error === "object" && googleStepFailures.has(error) ? "google_failed" : null;
}

interface CalendarMap {
  shared: string | null;
  lessons: Record<string, string>;
  sharedWith: string[];
  provisioning: { kind: "shared" } | { kind: "lesson"; child: string } | null;
}

type CalendarApi = calendar_v3.Calendar;
type CalendarEvent = calendar_v3.Schema$Event;

interface GoogleCalendarDependencies {
  sleep?(milliseconds: number): Promise<void>;
  random?(): number;
  log?(line: string): void;
}

export class GoogleCalendarService {
  private readonly tokenPath: string;
  private readonly calendarMapPath: string;

  constructor(private readonly config: AppConfig, private readonly dependencies: GoogleCalendarDependencies = {}) {
    mkdirSync(config.dataDir, { recursive: true });
    this.tokenPath = join(config.dataDir, "google-oauth-token.json");
    this.calendarMapPath = join(config.dataDir, "google-calendar-map.json");
  }

  authUrl(state: string, purpose: OAuthPurpose = "calendar"): string {
    return this.oauth().generateAuthUrl({
      access_type: "offline",
      ...(purpose === "calendar" ? { prompt: "consent" } : {}),
      state,
      scope: purpose === "calendar" ? ["openid", "email", APP_CREATED_SCOPE, ACL_SCOPE] : ["openid", "email"],
    });
  }

  isConnected(): boolean {
    const token = this.loadToken();
    return token?.family_wilma_calendar_scope === SCOPE_MARKER
      && token.family_wilma_calendar_owner === this.config.googleAllowedEmail;
  }

  async handleCallback(code: string, purpose: OAuthPurpose = "calendar"): Promise<string> {
    const client = this.oauth();
    const { tokens } = await client.getToken(code);
    if (!tokens.id_token) throw new Error("Google did not return an ID token");
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: this.config.googleClientId });
    const payload = ticket.getPayload();
    const email = payload?.email?.toLowerCase();
    if (!payload || !email || payload.email_verified !== true || !this.config.googleAllowedLoginEmails.includes(email)) {
      throw new UnauthorizedGoogleAccountError();
    }
    if (purpose === "login") return email;
    if (email !== this.config.googleAllowedEmail) throw new UnauthorizedGoogleAccountError();
    if (!tokens.access_token) throw new Error("Google did not return an access token");
    const tokenInfo = await client.getTokenInfo(tokens.access_token);
    if (!tokenInfo.scopes.includes(APP_CREATED_SCOPE) || !tokenInfo.scopes.includes(ACL_SCOPE)) {
      throw new Error("Google Calendar permission was not granted");
    }
    const previous = this.loadToken();
    const reusable = previous?.family_wilma_calendar_scope === SCOPE_MARKER
      && previous.family_wilma_calendar_owner === email ? previous : null;
    if (!reusable && !tokens.refresh_token) {
      throw new Error("Google did not return a refresh token for the calendar permission");
    }
    const merged = {
      ...(reusable ?? {}),
      ...tokens,
      family_wilma_calendar_scope: SCOPE_MARKER,
      family_wilma_calendar_owner: email,
    };
    writeFileSync(this.tokenPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
    return email;
  }

  async sync(plan: CalendarSyncPlan): Promise<CalendarSyncResult> {
    try {
      return await this.syncConnected(plan);
    } catch (error) {
      if (error instanceof CalendarSyncError) throw error;
      if (isInvalidGrant(error)) {
        // The owner revoked access or the refresh token expired. Forget it so the
        // page offers "Yhdistä Google Calendar" again instead of failing every sync.
        rmSync(this.tokenPath, { force: true });
        throw new CalendarSyncError("google_login_expired", error instanceof Error ? error : new Error("invalid_grant"));
      }
      // Rethrown as is, so error reporting still sees the original type and status.
      if (error && typeof error === "object") googleStepFailures.add(error);
      throw error;
    }
  }

  private async syncConnected(plan: CalendarSyncPlan): Promise<CalendarSyncResult> {
    const token = this.loadToken();
    if (!token || !this.isConnected()) throw new CalendarSyncError("google_not_connected", new Error("Google Calendar is not connected"));
    const auth = this.oauth();
    auth.setCredentials(token);
    auth.on("tokens", (tokens) => {
      const merged = { ...token, ...tokens };
      writeFileSync(this.tokenPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
    });
    const calendar = this.api(auth);
    const ids = await this.ensureCalendars(calendar, plan.lessonCalendars.map((entry) => entry.child));
    const mapping = this.loadCalendarMap();
    mapping.sharedWith = await this.ensureCalendarSharing(
      calendar,
      [ids.shared, ...Object.values(ids.lessons)],
      mapping.sharedWith,
    );
    this.saveCalendarMap(mapping);
    const totals = { created: 0, updated: 0, unchanged: 0, deleted: 0, skipped: 0 };
    const dropped = new Set(plan.droppedSourceIds ?? []);
    addCounts(totals, await this.syncCalendar(
      calendar,
      ids.shared,
      plan.sharedItems.filter((item) => !dropped.has(item.sourceId)),
      undefined,
      plan.sharedSupersededSourcePrefixes,
      dropped,
    ));
    for (const lessonCalendar of plan.lessonCalendars) {
      addCounts(totals, await this.syncCalendar(
        calendar,
        ids.lessons[lessonCalendar.child]!,
        lessonCalendar.items,
        lessonCalendar.reconcile ? plan.lessonWindow : undefined,
      ));
    }
    return totals;
  }

  private api(auth: OAuth2Client): CalendarApi {
    return calendarApi({ version: "v3", auth });
  }

  private async ensureCalendars(calendar: CalendarApi, children: string[]): Promise<{ shared: string; lessons: Record<string, string> }> {
    const mapping = this.loadCalendarMap();
    if (mapping.provisioning) await this.recoverProvisioning(calendar, mapping);
    if (mapping.shared && !await this.calendarExists(calendar, mapping.shared)) {
      mapping.shared = null;
      this.saveCalendarMap(mapping);
    }
    if (!mapping.shared) {
      mapping.shared = await this.provisionCalendar(calendar, mapping, { kind: "shared" }, calendarSummary({ kind: "shared" }));
    }
    for (const child of [...new Set(children)].sort((left, right) => left.localeCompare(right, "fi"))) {
      if (Object.hasOwn(mapping.lessons, child) && await this.calendarExists(calendar, mapping.lessons[child]!)) continue;
      if (Object.hasOwn(mapping.lessons, child)) {
        delete mapping.lessons[child];
        this.saveCalendarMap(mapping);
      }
      mapping.lessons[child] = await this.provisionCalendar(calendar, mapping, { kind: "lesson", child }, calendarSummary({ kind: "lesson", child }));
    }
    return { shared: mapping.shared, lessons: mapping.lessons };
  }

  /**
   * A creation that timed out may or may not have made the calendar. Adopt an
   * owned calendar with the exact name if Google lists one; otherwise forget the
   * attempt so this sync creates it. Leaving the marker stopped every later sync.
   */
  private async recoverProvisioning(calendar: CalendarApi, mapping: CalendarMap): Promise<void> {
    const target = mapping.provisioning!;
    const summary = calendarSummary(target);
    const known = new Set([mapping.shared, ...Object.values(mapping.lessons)]);
    let found: string | undefined;
    try {
      let pageToken: string | undefined;
      do {
        const response = await this.request(() => calendar.calendarList.list({
          minAccessRole: "owner",
          maxResults: 250,
          ...(pageToken ? { pageToken } : {}),
        }));
        found ??= (response.data.items ?? []).find((entry) => entry.id && entry.summary === summary && !known.has(entry.id))?.id ?? undefined;
        pageToken = response.data.nextPageToken ?? undefined;
      } while (pageToken && !found);
    } catch (error) {
      if (!isDefiniteRejection(error)) throw error;
    }
    if (found) {
      if (target.kind === "shared") mapping.shared = found;
      else mapping.lessons[target.child] = found;
    }
    this.dependencies.log?.(`calendar creation recovered: ${target.kind} ${found ? "adopted" : "will be created again"}`);
    mapping.provisioning = null;
    this.saveCalendarMap(mapping);
  }

  private async calendarExists(calendar: CalendarApi, calendarId: string): Promise<boolean> {
    try {
      await this.request(() => calendar.calendars.get({ calendarId }));
      return true;
    } catch (error) {
      if (httpStatus(error) === 404) return false;
      throw error;
    }
  }

  private async ensureCalendarSharing(
    calendar: CalendarApi,
    calendarIds: string[],
    previouslySharedWith: string[],
  ): Promise<string[]> {
    const recipients = this.config.googleAllowedLoginEmails.filter((email) => email !== this.config.googleAllowedEmail);
    const removedRecipients = previouslySharedWith.filter((email) => !recipients.includes(email));
    if (!recipients.length && !removedRecipients.length) return recipients;
    for (const calendarId of [...new Set(calendarIds)]) {
      const rules: calendar_v3.Schema$AclRule[] = [];
      let pageToken: string | undefined;
      do {
        const response = await this.request(() => calendar.acl.list({
          calendarId,
          maxResults: 250,
          ...(pageToken ? { pageToken } : {}),
        }));
        rules.push(...(response.data.items ?? []));
        pageToken = response.data.nextPageToken ?? undefined;
      } while (pageToken);
      for (const email of removedRecipients) {
        const existing = rules.find((rule) =>
          rule.scope?.type === "user" && rule.scope.value?.toLowerCase() === email,
        );
        if (existing?.id && existing.role !== "owner") {
          await this.writeRequest(() => calendar.acl.delete({ calendarId, ruleId: existing.id! }));
        }
      }
      for (const email of recipients) {
        const existing = rules.find((rule) =>
          rule.scope?.type === "user" && rule.scope.value?.toLowerCase() === email,
        );
        if (existing?.role === "reader" || existing?.role === "owner") continue;
        if (existing?.id) {
          await this.writeRequest(() => calendar.acl.update({
            calendarId,
            ruleId: existing.id!,
            requestBody: { role: "reader", scope: { type: "user", value: email } },
          }));
        } else {
          await this.writeRequest(() => calendar.acl.insert({
            calendarId,
            sendNotifications: true,
            requestBody: { role: "reader", scope: { type: "user", value: email } },
          }));
        }
      }
    }
    return recipients;
  }

  private async provisionCalendar(
    calendar: CalendarApi,
    mapping: CalendarMap,
    target: Exclude<CalendarMap["provisioning"], null>,
    summary: string,
  ): Promise<string> {
    mapping.provisioning = target;
    this.saveCalendarMap(mapping);
    try {
      const id = await this.createCalendar(calendar, summary);
      if (target.kind === "shared") mapping.shared = id;
      else mapping.lessons[target.child] = id;
      mapping.provisioning = null;
      this.saveCalendarMap(mapping);
      return id;
    } catch (error) {
      if (isDefiniteRejection(error)) {
        mapping.provisioning = null;
        this.saveCalendarMap(mapping);
      }
      throw error;
    }
  }

  private async createCalendar(calendar: CalendarApi, summary: string): Promise<string> {
    const created = await this.writeRequest(() => calendar.calendars.insert({
      requestBody: { summary, timeZone: HELSINKI_TIME_ZONE },
    }));
    if (!created.data.id) throw new Error("Google did not return a calendar id");
    return created.data.id;
  }

  private async syncCalendar(
    calendar: CalendarApi,
    calendarId: string,
    items: SourceCalendarItem[],
    reconcileWindow?: LessonWindow,
    cleanupSourcePrefixes: string[] = [],
    droppedSourceIds: ReadonlySet<string> = new Set(),
  ): Promise<CalendarSyncResult> {
    const existing = await this.managedEvents(calendar, calendarId, reconcileWindow);
    const bySource = new Map(existing.map((event) => [event.extendedProperties?.private?.familyWilmaSourceId, event]));
    const desiredSources = new Set(items.map((item) => item.sourceId));
    const supersededSourcePrefixes = new Set(cleanupSourcePrefixes);
    const counts = { created: 0, updated: 0, unchanged: 0, deleted: 0, skipped: 0 };
    const migratedIds = new Set<string>();
    await forEachConcurrent(items, 1, async (item) => {
      try {
        await this.syncItem(calendar, calendarId, item, existing, bySource, migratedIds, counts);
      } catch (error) {
        // One malformed item must not stop every other event from reaching Google.
        if (!isItemRejection(error)) throw error;
        counts.skipped += 1;
        this.dependencies.log?.(`calendar item skipped: ${item.sourceId} ${item.date} time=${JSON.stringify(item.time)} (${itemRejectionReason(error)})`);
      }
    });
    const deletedIds = new Set<string>();
    if (droppedSourceIds.size) {
      await forEachConcurrent(existing, 1, async (event) => {
        const sourceId = event.extendedProperties?.private?.familyWilmaSourceId;
        if (!event.id || migratedIds.has(event.id) || !sourceId || !droppedSourceIds.has(sourceId)) return;
        await this.writeRequest(() => calendar.events.delete({ calendarId, eventId: event.id! }));
        deletedIds.add(event.id);
        counts.deleted += 1;
      });
    }
    if (supersededSourcePrefixes.size) {
      await forEachConcurrent(existing, 1, async (event) => {
        const sourceId = event.extendedProperties?.private?.familyWilmaSourceId;
        if (!event.id || migratedIds.has(event.id) || deletedIds.has(event.id) || !sourceId || desiredSources.has(sourceId)
            || ![...supersededSourcePrefixes].some((prefix) => sourceId.startsWith(prefix))) return;
        await this.writeRequest(() => calendar.events.delete({ calendarId, eventId: event.id! }));
        deletedIds.add(event.id);
        counts.deleted += 1;
      });
    }
    if (reconcileWindow) {
      await forEachConcurrent(existing, 1, async (event) => {
        const sourceId = event.extendedProperties?.private?.familyWilmaSourceId;
        const date = eventLocalDate(event);
        if (!event.id || deletedIds.has(event.id) || !sourceId || desiredSources.has(sourceId) || !date || date < reconcileWindow.deleteFrom) return;
        const eventId = event.id;
        await this.writeRequest(() => calendar.events.delete({ calendarId, eventId }));
        counts.deleted += 1;
      });
    }
    return counts;
  }

  private async syncItem(
    calendar: CalendarApi,
    calendarId: string,
    item: SourceCalendarItem,
    existing: CalendarEvent[],
    bySource: Map<string | undefined, CalendarEvent>,
    migratedIds: Set<string>,
    counts: CalendarSyncResult,
  ): Promise<void> {
    const desired = this.eventFor(item);
    const event = bySource.get(item.sourceId) ?? existing.find((candidate) => {
      const sourceId = candidate.extendedProperties?.private?.familyWilmaSourceId;
      return candidate.id && !migratedIds.has(candidate.id) && sourceId
        && (item.supersededSourceIds ?? []).includes(sourceId);
    });
    if (!event?.id) {
      await this.writeRequest(() => calendar.events.insert({ calendarId, requestBody: desired }));
      counts.created += 1;
    } else if (event.extendedProperties?.private?.familyWilmaSourceId === item.sourceId && this.sameEvent(event, desired)) {
      counts.unchanged += 1;
    } else {
      const eventId = event.id;
      await this.writeRequest(() => calendar.events.update({ calendarId, eventId, requestBody: desired }));
      migratedIds.add(eventId);
      counts.updated += 1;
    }
  }

  private async managedEvents(calendar: CalendarApi, calendarId: string, window?: LessonWindow): Promise<CalendarEvent[]> {
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.request(() => calendar.events.list({
        calendarId,
        privateExtendedProperty: [`familyWilmaManagedBy=${MANAGED_BY}`],
        singleEvents: true,
        showDeleted: false,
        maxResults: 2500,
        ...(pageToken ? { pageToken } : {}),
        ...(window ? {
          timeMin: `${window.start}T00:00:00Z`,
          timeMax: `${dayAfter(window.end)}T00:00:00Z`,
        } : {}),
      }));
      events.push(...(response.data.items ?? []));
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    return events;
  }

  private oauth() {
    return new OAuth2Client(
      this.config.googleClientId,
      this.config.googleClientSecret,
      `${this.config.baseUrl}/oauth/google/callback`,
    );
  }

  private async writeRequest<T>(action: () => Promise<T>): Promise<T> {
    await this.sleep(WRITE_INTERVAL_MS);
    return await this.request(action);
  }

  private async request<T>(action: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await action();
      } catch (error) {
        if (!isRateLimitRejection(error) || attempt >= MAX_RATE_LIMIT_RETRIES) throw error;
        const exponential = 2 ** attempt * 1_000;
        const jitter = Math.floor((this.dependencies.random?.() ?? Math.random()) * 1_000);
        await this.sleep(Math.min(exponential + jitter, 32_000));
      }
    }
  }

  private async sleep(milliseconds: number): Promise<void> {
    if (this.dependencies.sleep) return await this.dependencies.sleep(milliseconds);
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
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
    if (item.time && !isClock(item.time)) throw new InvalidCalendarItemError(`time ${JSON.stringify(item.time)}`);
    if (item.endTime && !isClock(item.endTime)) throw new InvalidCalendarItemError(`end time ${JSON.stringify(item.endTime)}`);
    const start = item.time
      ? { dateTime: `${item.date}T${item.time}:00`, timeZone: HELSINKI_TIME_ZONE }
      : { date: item.date };
    let end: { date?: string; dateTime?: string; timeZone?: string };
    if (item.time) {
      end = {
        dateTime: item.endTime && item.endTime > item.time
          ? `${item.date}T${item.endTime}:00`
          : addOneHourToLocalDateTime(item.date, item.time),
        timeZone: HELSINKI_TIME_ZONE,
      };
    } else {
      // An end date before the start would make Google reject the event outright.
      const lastDay = item.endDate && item.endDate > item.date ? item.endDate : item.date;
      const exclusiveEnd = new Date(`${lastDay}T00:00:00Z`);
      exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
      end = { date: exclusiveEnd.toISOString().slice(0, 10) };
    }
    return {
      summary: item.title,
      description: item.description ?? null,
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

  private loadCalendarMap(): CalendarMap {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.calendarMapPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Invalid Google calendar map");
      }
      const candidate = parsed as Partial<CalendarMap>;
      if (candidate.shared !== null && candidate.shared !== undefined && typeof candidate.shared !== "string") {
        throw new Error("Invalid shared calendar id in Google calendar map");
      }
      if (candidate.lessons !== undefined && (!candidate.lessons || typeof candidate.lessons !== "object" || Array.isArray(candidate.lessons)
        || Object.values(candidate.lessons).some((value) => typeof value !== "string"))) {
        throw new Error("Invalid lesson calendar ids in Google calendar map");
      }
      if (candidate.sharedWith !== undefined && (!Array.isArray(candidate.sharedWith)
        || candidate.sharedWith.some((value) => typeof value !== "string"))) {
        throw new Error("Invalid shared recipients in Google calendar map");
      }
      const provisioning = parseProvisioning(candidate.provisioning);
      const lessons = Object.assign(Object.create(null) as Record<string, string>,
        candidate.lessons && typeof candidate.lessons === "object" && !Array.isArray(candidate.lessons)
          ? Object.fromEntries(Object.entries(candidate.lessons).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
          : {});
      return {
        shared: typeof candidate.shared === "string" ? candidate.shared : null,
        lessons,
        sharedWith: candidate.sharedWith?.map((email) => email.toLowerCase()) ?? [],
        provisioning,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { shared: null, lessons: Object.create(null) as Record<string, string>, sharedWith: [], provisioning: null };
    }
  }

  private saveCalendarMap(mapping: CalendarMap): void {
    const temporary = `${this.calendarMapPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(mapping, null, 2), { mode: 0o600 });
    renameSync(temporary, this.calendarMapPath);
    chmodSync(this.calendarMapPath, 0o600);
  }
}

export class UnauthorizedGoogleAccountError extends Error {
  constructor() {
    super("Google account is not allowed");
    this.name = "UnauthorizedGoogleAccountError";
  }
}

class InvalidCalendarItemError extends Error {
  constructor(detail: string) {
    super(`Invalid calendar item ${detail}`);
    this.name = "InvalidCalendarItemError";
  }
}

function calendarSummary(target: Exclude<CalendarMap["provisioning"], null>): string {
  return target.kind === "shared" ? "Family Wilma – yhteiset" : `${target.child} – Lukujärjestys`;
}

function isClock(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** Errors that belong to one item: a value we could not use, or Google refusing that event. */
function isItemRejection(error: unknown): boolean {
  // An expired permission is also HTTP 400, but it fails the whole sync, not one item.
  return error instanceof InvalidCalendarItemError || (httpStatus(error) === 400 && !isInvalidGrant(error));
}

function itemRejectionReason(error: unknown): string {
  if (error instanceof InvalidCalendarItemError) return error.message;
  const candidate = error as { response?: { data?: { error?: { message?: unknown; errors?: Array<{ reason?: unknown }> } } } };
  const detail = candidate.response?.data?.error;
  const reason = typeof detail?.errors?.[0]?.reason === "string" ? detail.errors[0].reason : "";
  const message = typeof detail?.message === "string" ? detail.message : "";
  return `HTTP 400${reason ? ` ${reason}` : ""}${message ? `: ${message}` : ""}`;
}

function isInvalidGrant(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { message?: unknown; response?: { data?: { error?: unknown } } };
  return candidate.response?.data?.error === "invalid_grant" || candidate.message === "invalid_grant";
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

function dayAfter(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function eventLocalDate(event: CalendarEvent): string | null {
  if (event.start?.date) return event.start.date;
  const local = localHelsinkiDateTime(event.start?.dateTime);
  return local?.slice(0, 10) ?? null;
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { status?: unknown; response?: { status?: unknown } };
  const status = candidate.status ?? candidate.response?.status;
  return typeof status === "number" ? status : undefined;
}

function isDefiniteRejection(error: unknown): boolean {
  const status = httpStatus(error);
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function isRateLimitRejection(error: unknown): boolean {
  const status = httpStatus(error);
  if (status !== 403 && status !== 429) return false;
  if (!error || typeof error !== "object") return status === 429;
  const candidate = error as {
    errors?: Array<{ reason?: unknown }>;
    response?: { data?: { error?: { errors?: Array<{ reason?: unknown }> } } };
  };
  const reason = candidate.response?.data?.error?.errors?.[0]?.reason ?? candidate.errors?.[0]?.reason;
  return status === 429 || reason === "rateLimitExceeded" || reason === "userRateLimitExceeded";
}

function parseProvisioning(value: unknown): CalendarMap["provisioning"] {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid provisioning state in Google calendar map");
  const candidate = value as { kind?: unknown; child?: unknown };
  if (candidate.kind === "shared") return { kind: "shared" };
  if (candidate.kind === "lesson" && typeof candidate.child === "string" && candidate.child) {
    return { kind: "lesson", child: candidate.child };
  }
  throw new Error("Invalid provisioning state in Google calendar map");
}

function addCounts(target: CalendarSyncResult, source: CalendarSyncResult): void {
  target.created += source.created;
  target.updated += source.updated;
  target.unchanged += source.unchanged;
  target.deleted += source.deleted;
  target.skipped += source.skipped;
}

async function forEachConcurrent<T>(items: T[], concurrency: number, action: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await action(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}
