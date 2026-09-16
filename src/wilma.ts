import { WilmaClient, WilmaSession, type HomeworkItem, type StudentInfo, type WilmaProfile } from "@wilm-ai/wilma-client";
import type { AppConfig, ProfileMapping, WilmaAccountConfig } from "./config.js";
import { diaryCutoff, parseDiaryGroups, parseGroupDiary } from "./wilma-diary.js";

export class MfaCodeRequiredError extends Error {
  constructor(readonly accountId: string) {
    super(`Wilma MFA code required for ${accountId}`);
    this.name = "MfaCodeRequiredError";
  }
}

export interface FetchedMessage {
  sourceType?: "message" | "notice";
  accountId: string;
  studentNumber: string;
  child: string;
  messageId: number;
  subject: string;
  sender: string;
  sentAt: Date;
  content: string;
}

export interface FetchedHomework extends HomeworkItem {
  accountId: string;
  studentNumber: string;
  child: string;
  /** "diary" marks a lesson-diary entry; absent means Wilma's own homework field. */
  source?: "homework" | "diary";
}

export interface FetchedExam {
  sourceId: string;
  child: string;
  subject: string;
  date: string;
  description: string;
  teacher: string;
}

/** The one place the exam source id is built, so the view and sync cannot drift. */
export function examSourceId(accountId: string, studentNumber: string, examId: number): string {
  return `wilma-exam:${accountId}:${studentNumber}:${examId}`;
}

export interface SourceCalendarItem {
  sourceId: string;
  title: string;
  date: string;
  time: string | null;
  endTime?: string | null;
  endDate: string | null;
  description: string | null;
  supersededSourceIds?: string[];
}

export interface LessonCalendar {
  child: string;
  items: SourceCalendarItem[];
  reconcile: boolean;
}

export interface LessonWindow {
  start: string;
  end: string;
  deleteFrom: string;
}

export interface WilmaBundle {
  messages: FetchedMessage[];
  structuredCalendarItems: SourceCalendarItem[];
  lessonCalendars: LessonCalendar[];
  lessonWindow: LessonWindow | null;
}

/** The authenticated, student-prefixed page reads the lesson diary needs. */
export interface DiaryPageReader {
  get(path: string): Promise<string>;
}

export interface DiaryOptions {
  onError?: (error: unknown) => void;
  openSession?: (account: WilmaAccountConfig, studentNumber: string) => Promise<DiaryPageReader>;
}

async function openWilmaSession(
  account: WilmaAccountConfig,
  studentNumber: string,
): Promise<DiaryPageReader> {
  const session = new WilmaSession(account.baseUrl, { studentNumber });
  await session.login(account.username, account.password);
  return { get: async (path) => (await session.get(path)).text() };
}

export class WilmaService {
  private readonly mfaCodes = new Map<string, string>();
  private readonly pendingDiscoveries = new Map<string, Promise<StudentInfo[]>>();
  private readonly pendingClients = new Map<string, Promise<WilmaClient>>();

  constructor(
    private readonly config: AppConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly diary: DiaryOptions = {},
  ) {}

  submitMfaCode(accountId: string, code: string): void {
    if (!this.config.wilmaAccounts.some((account) => account.id === accountId)) {
      throw new Error("Unknown Wilma account");
    }
    const clean = code.trim();
    if (!clean) throw new Error("MFA code cannot be empty");
    this.mfaCodes.set(accountId, clean);
  }

  async discoverProfiles(accountId: string): Promise<StudentInfo[]> {
    const account = this.account(accountId);
    return WilmaClient.listStudents(this.baseProfile(account), this.mfaCallback(account));
  }

  async fetchHomework(): Promise<FetchedHomework[]> {
    const homework: FetchedHomework[] = [];
    for (const account of this.config.wilmaAccounts) {
      const profiles = await this.profilesForAccount(account);
      for (const profile of profiles) {
        const client = await this.clientForFetch(account, profile);
        const overview = await client.overview.get();
        homework.push(...overview.homework.map((item) => ({
          ...item,
          accountId: account.id,
          studentNumber: profile.studentNumber,
          child: profile.child,
          source: "homework" as const,
        })));
        homework.push(...await this.fetchLessonDiary(account, profile));
      }
    }
    homework.sort((left, right) => right.date.localeCompare(left.date)
      || left.child.localeCompare(right.child, "fi")
      || left.subject.localeCompare(right.subject, "fi"));
    this.clearCompletedFetchState();
    return homework;
  }

  /**
   * Upcoming exams for every child, with the same source ids calendar sync
   * writes, so the homework page can offer one checkbox per exam.
   */
  async fetchExams(): Promise<FetchedExam[]> {
    const exams: FetchedExam[] = [];
    for (const account of this.config.wilmaAccounts) {
      for (const profile of await this.profilesForAccount(account)) {
        const client = await this.clientForFetch(account, profile);
        for (const exam of await client.exams.list()) {
          exams.push({
            sourceId: examSourceId(account.id, profile.studentNumber, exam.wilmaId),
            child: profile.child,
            subject: exam.subject,
            date: exam.dateString,
            description: [exam.description, exam.notes].map((value) => value?.trim()).filter(Boolean).join(" · "),
            teacher: exam.teacher?.trim() ?? "",
          });
        }
      }
    }
    exams.sort((left, right) => left.date.localeCompare(right.date)
      || left.child.localeCompare(right.child, "fi")
      || left.subject.localeCompare(right.subject, "fi"));
    this.clearCompletedFetchState();
    return exams;
  }

  /**
   * Lesson-diary entries for one student, newest first and limited to the diary
   * window. Wilma's own homework field is empty for teachers who write homework
   * into the diary, so both sources are shown. A diary failure must never hide
   * the homework that was already fetched, so it is reported and dropped.
   */
  private async fetchLessonDiary(
    account: WilmaAccountConfig,
    profile: ProfileMapping,
  ): Promise<FetchedHomework[]> {
    const notBefore = diaryCutoff(this.now());
    try {
      const session = await (this.diary.openSession ?? openWilmaSession)(account, profile.studentNumber);
      const groups = parseDiaryGroups(await session.get("/"));
      const entries: FetchedHomework[] = [];
      for (const group of groups) {
        const page = await session.get(`/groups/${group.groupId}`);
        entries.push(...parseGroupDiary(page, group, notBefore).map((entry) => ({
          accountId: account.id,
          studentNumber: profile.studentNumber,
          child: profile.child,
          date: entry.date,
          subject: entry.subject,
          subjectCode: entry.subjectCode,
          homework: entry.text,
          teacher: entry.teacher,
          teacherCode: "",
          source: "diary" as const,
        })));
      }
      return entries;
    } catch (error) {
      this.diary.onError?.(error);
      return [];
    }
  }

  async fetchAll(options: { sentAfter?: Date; includeLessons?: boolean } = {}): Promise<WilmaBundle> {
    try {
      return await this.fetchAllOnce(options);
    } catch (error) {
      if (!(error instanceof MfaCodeRequiredError)) this.clearCompletedFetchState();
      throw error;
    }
  }

  private async fetchAllOnce(options: { sentAfter?: Date; includeLessons?: boolean }): Promise<WilmaBundle> {
    const messages: FetchedMessage[] = [];
    const structuredCalendarItems: SourceCalendarItem[] = [];
    const lessonItemsByChild = new Map<string, Map<string, SourceCalendarItem>>();
    const lessonReconcileByChild = new Map<string, boolean>();
    const lessonWindow = options.includeLessons ? sixMonthLessonWindow(this.now()) : null;
    const scheduleDates = lessonWindow ? weeklyDates(lessonWindow.start, lessonWindow.end) : [];
    for (const account of this.config.wilmaAccounts) {
      const profiles = await this.profilesForAccount(account);
      for (const profile of profiles) {
        const client = await this.clientForFetch(account, profile);
        const listed = await client.messages.list("inbox");
        const selected = options.sentAfter
          ? listed.filter((summary) => summary.sentAt.getTime() >= options.sentAfter!.getTime())
          : listed;
        for (const summary of selected) {
          const detail = await client.messages.get(summary.wilmaId);
          messages.push({
            accountId: account.id,
            studentNumber: profile.studentNumber,
            child: profile.child,
            messageId: detail.wilmaId,
            subject: detail.subject || summary.subject || "(ei otsikkoa)",
            sender: detail.senderName?.trim() || "Wilma",
            sentAt: detail.sentAt,
            content: detail.content?.trim() || "",
          });
        }
        const listedNotices = await client.news?.list?.() ?? [];
        const selectedNotices = options.sentAfter
          ? listedNotices.filter((notice) => notice.published && notice.published.getTime() >= options.sentAfter!.getTime())
          : listedNotices;
        for (const summary of selectedNotices) {
          const detail = await client.news.get(summary.wilmaId);
          const published = detail.published ?? summary.published;
          if (!published) continue;
          const resources = (detail.resources ?? []).map((resource) => `${resource.label}: ${resource.url}`);
          messages.push({
            sourceType: "notice",
            accountId: account.id,
            studentNumber: profile.studentNumber,
            child: profile.child,
            messageId: detail.wilmaId,
            subject: detail.title?.trim() || summary.title?.trim() || "(ei otsikkoa)",
            sender: detail.author?.trim() || summary.author?.trim() || "Wilma-tiedote",
            sentAt: published,
            content: [detail.subtitle?.trim(), detail.content?.trim(), ...resources]
              .filter((value): value is string => Boolean(value))
              .join("\n\n"),
          });
        }
        const exams = await client.exams.list();
        for (const exam of exams) {
          structuredCalendarItems.push({
            sourceId: examSourceId(account.id, profile.studentNumber, exam.wilmaId),
            title: `${profile.child}: ${exam.subject}`,
            date: exam.dateString,
            time: null,
            endDate: null,
            description: [exam.description, exam.notes, exam.teacher ? `Opettaja: ${exam.teacher}` : null]
              .filter((value): value is string => Boolean(value && value.trim()))
              .join("\n") || null,
          });
        }
        if (lessonWindow && account.includeLessons !== false) {
          const childLessons = lessonItemsByChild.get(profile.child) ?? new Map<string, SourceCalendarItem>();
          lessonItemsByChild.set(profile.child, childLessons);
          if (!lessonReconcileByChild.has(profile.child)) lessonReconcileByChild.set(profile.child, true);
          for (const date of scheduleDates) {
            const lessons = await client.schedule.list({ date });
            for (const lesson of lessons) {
              if (!validLesson(lesson.date, lesson.start, lesson.end, lessonWindow)) {
                lessonReconcileByChild.set(profile.child, false);
                continue;
              }
              const stablePart = lesson.groupId
                ? String(lesson.groupId)
                : `${lesson.subjectCode || lesson.subject}:${lesson.start}`;
              const sourceId = `wilma-lesson:${lesson.date}:${lesson.start}:${stablePart}`;
              childLessons.set(sourceId, {
                sourceId,
                title: lesson.subject || lesson.subjectCode || "Oppitunti",
                date: lesson.date,
                time: lesson.start,
                endTime: lesson.end,
                endDate: null,
                description: teacherDescription(lesson.teacher, lesson.teacherCode),
              });
            }
          }
        }
      }
    }
    messages.sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
    this.clearCompletedFetchState();
    const lessonCalendars = [...lessonItemsByChild.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "fi"))
      .map(([child, items]) => ({
        child,
        items: [...items.values()].sort((left, right) => left.date.localeCompare(right.date)
          || (left.time ?? "").localeCompare(right.time ?? "")),
        // The client currently reports an empty array both for a genuinely empty
        // schedule and for an unrecognised Wilma response. Never turn that
        // ambiguity into a destructive full-calendar reconciliation.
        reconcile: items.size > 0 && lessonReconcileByChild.get(child) === true,
      }));
    return { messages, structuredCalendarItems, lessonCalendars, lessonWindow };
  }

  private async profilesForAccount(account: WilmaAccountConfig): Promise<ProfileMapping[]> {
    const discovered = await this.profilesForFetch(account);
    const childOverrides = new Map(account.profiles.map((profile) => [profile.studentNumber, profile.child]));
    return discovered.map((profile) => ({
      studentNumber: profile.studentNumber,
      child: childOverrides.get(profile.studentNumber) ?? (profile.name.trim() || profile.studentNumber),
    }));
  }

  private clearCompletedFetchState(): void {
    this.pendingDiscoveries.clear();
    this.pendingClients.clear();
    this.mfaCodes.clear();
  }

  private async profilesForFetch(account: WilmaAccountConfig): Promise<StudentInfo[]> {
    let pending = this.pendingDiscoveries.get(account.id);
    if (!pending) {
      pending = WilmaClient.listStudents(this.baseProfile(account), this.mfaCallback(account));
      this.pendingDiscoveries.set(account.id, pending);
    }
    try {
      return await pending;
    } catch (error) {
      if (this.pendingDiscoveries.get(account.id) === pending) this.pendingDiscoveries.delete(account.id);
      throw error;
    }
  }

  private async clientForFetch(account: WilmaAccountConfig, profile: ProfileMapping): Promise<WilmaClient> {
    const key = `${account.id}\0${profile.studentNumber}`;
    let pending = this.pendingClients.get(key);
    if (!pending) {
      pending = WilmaClient.login(this.profile(account, profile), this.mfaCallback(account));
      this.pendingClients.set(key, pending);
    }
    try {
      return await pending;
    } catch (error) {
      if (this.pendingClients.get(key) === pending) this.pendingClients.delete(key);
      throw error;
    }
  }

  private account(accountId: string): WilmaAccountConfig {
    const account = this.config.wilmaAccounts.find((candidate) => candidate.id === accountId);
    if (!account) throw new Error("Unknown Wilma account");
    return account;
  }

  private baseProfile(account: WilmaAccountConfig): WilmaProfile {
    return { baseUrl: account.baseUrl, username: account.username, password: account.password };
  }

  private profile(account: WilmaAccountConfig, mapping: ProfileMapping): WilmaProfile {
    return { ...this.baseProfile(account), studentNumber: mapping.studentNumber };
  }

  private mfaCallback(account: WilmaAccountConfig): (formkey: string) => Promise<string> {
    return async () => {
      const code = this.mfaCodes.get(account.id);
      if (!code) throw new MfaCodeRequiredError(account.id);
      this.mfaCodes.delete(account.id);
      return code;
    };
  }
}

function sixMonthLessonWindow(now: Date): LessonWindow {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Helsinki",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const todayDate = isoDate(today);
  const day = todayDate.getUTCDay() || 7;
  const start = addDays(todayDate, 1 - day);
  const targetMonth = todayDate.getUTCMonth() + 6;
  const targetYear = todayDate.getUTCFullYear() + Math.floor(targetMonth / 12);
  const month = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate();
  const end = new Date(Date.UTC(targetYear, month, Math.min(todayDate.getUTCDate(), lastDay)));
  return { start: dateString(start), end: dateString(end), deleteFrom: today };
}

function weeklyDates(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let date = isoDate(start); date <= isoDate(end); date = addDays(date, 7)) dates.push(dateString(date));
  return dates;
}

function isoDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function addDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function dateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function validLesson(date: string, start: string, end: string, window: LessonWindow): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date)
    && validTime(start)
    && validTime(end)
    && start < end
    && date >= window.start
    && date <= window.end;
}

function validTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function teacherDescription(teacher: string, code: string): string | null {
  const name = teacher.trim();
  const short = code.trim();
  if (name && short) return `Opettaja: ${name} (${short})`;
  if (name || short) return `Opettaja: ${name || short}`;
  return null;
}
