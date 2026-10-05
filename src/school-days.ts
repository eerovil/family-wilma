import type { LessonNote, ScheduleLesson } from "@wilm-ai/wilma-client";

/** One child's school morning: when the first lesson starts and whether the child is away for it. */
export interface SchoolDay {
  child: string;
  /** YYYY-MM-DD, Helsinki date */
  date: string;
  /** HH:MM, or null when the child has no lessons that day */
  firstLessonStart: string | null;
  absent: boolean;
}

/** Today and the next seven days, as Home Assistant needs them for the dawn light. */
export const SCHOOL_DAY_COUNT = 8;

export function helsinkiDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Helsinki",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDaysToDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** The dates to report, and one date in each Wilma week they fall in (the schedule is read a week at a time). */
export function schoolDayWindow(now: Date): { dates: string[]; weekDates: string[] } {
  const today = helsinkiDate(now);
  const dates = Array.from({ length: SCHOOL_DAY_COUNT }, (_, index) => addDaysToDate(today, index));
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
  const monday = addDaysToDate(today, 1 - weekday);
  const weekDates = [monday, addDaysToDate(monday, 7)];
  return { dates, weekDates };
}

export function firstLessonStarts(lessons: ScheduleLesson[]): Map<string, string> {
  const first = new Map<string, string>();
  for (const lesson of lessons) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(lesson.start)) continue;
    const current = first.get(lesson.date);
    if (!current || lesson.start < current) first.set(lesson.date, lesson.start);
  }
  return first;
}

/**
 * Wilma marks an absence per lesson ("Poissa -terveydelliset syyt"). The note's
 * time comes from the attendance grid, which only knows whole hours, so it is
 * compared to the first lesson by hour. A note without a time falls outside the
 * school-day grid and is not a morning absence.
 */
export function isMorningAbsence(note: LessonNote, firstLessonStart: string): boolean {
  if (!/poissa/i.test(note.typeLabel) || !note.start) return false;
  return note.start.slice(0, 2) <= firstLessonStart.slice(0, 2);
}

/** Merges the same child read from several Wilma accounts: earliest lesson wins, an absence anywhere counts. */
export function mergeSchoolDays(days: SchoolDay[]): SchoolDay[] {
  const byKey = new Map<string, SchoolDay>();
  for (const day of days) {
    const key = `${day.child}\0${day.date}`;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, { ...day });
      continue;
    }
    const starts = [current.firstLessonStart, day.firstLessonStart].filter((value): value is string => Boolean(value));
    current.firstLessonStart = starts.sort()[0] ?? null;
    current.absent = current.absent || day.absent;
  }
  return [...byKey.values()].sort((left, right) => left.child.localeCompare(right.child, "fi")
    || left.date.localeCompare(right.date));
}

export function isSchoolDayArray(value: unknown): value is SchoolDay[] {
  return Array.isArray(value) && value.every((item) => Boolean(item && typeof item === "object"
    && typeof (item as SchoolDay).child === "string"
    && typeof (item as SchoolDay).date === "string"
    && (typeof (item as SchoolDay).firstLessonStart === "string" || (item as SchoolDay).firstLessonStart === null)
    && typeof (item as SchoolDay).absent === "boolean"));
}
