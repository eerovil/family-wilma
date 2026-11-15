import { createHash, timingSafeEqual } from "node:crypto";
import type { PedanetHomework } from "./pedanet-homework.js";
import { helsinkiDate, type SchoolDay } from "./school-days.js";
import type { FetchedExam, FetchedHomework } from "./wilma.js";

export const HOME_ASSISTANT_SCHOOL_DAYS_PATH = "/api/home-assistant/school-days";
export const KITCHEN_HOMEWORK_PATH = "/api/kitchen/homework";
/** How far back the kitchen sees homework: the same 14 days the lesson diary covers. */
export const KITCHEN_HOMEWORK_DAYS = 14;

export interface JsonResponse {
  status: number;
  body: unknown;
}

/** Compares the request's bearer token to the configured one without leaking its length or content through timing. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? "");
  if (!match) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(match[1]!.trim()), digest(token));
}

/**
 * The one address Home Assistant reads for the dawn light. It is gated by its
 * own token instead of the Google sign-in, and returns only each child's first
 * lesson start and absence for today onwards: no subjects, teachers or messages.
 * Without a configured token the address does not exist.
 */
export function homeAssistantSchoolDays(
  token: string | null,
  authorization: string | undefined,
  saved: { schoolDays: SchoolDay[]; updatedAt: string | null },
  now: Date,
): JsonResponse {
  if (!token) return { status: 404, body: { error: "not_found" } };
  if (!bearerMatches(authorization, token)) return { status: 401, body: { error: "unauthorized" } };
  const today = helsinkiDate(now);
  const children: Record<string, Array<Omit<SchoolDay, "child">>> = {};
  for (const day of saved.schoolDays) {
    if (day.date < today) continue;
    (children[day.child] ??= []).push({ date: day.date, firstLessonStart: day.firstLessonStart, absent: day.absent });
  }
  return { status: 200, body: { fetchedAt: saved.updatedAt, children } };
}

function daysBefore(date: string, days: number): string {
  const day = new Date(`${date}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() - days);
  return day.toISOString().slice(0, 10);
}

/**
 * The kitchen voice assistant's homework address (eerovil/eeron-omat-taskit#218). It shares
 * Home Assistant's token, an owner's choice on that issue, and returns the saved homework,
 * lesson-diary entries, exams and class-page homework from the last 14 days onward: child
 * first name, date, subject and text only, no teachers, student numbers or messages.
 */
export function kitchenHomework(
  token: string | null,
  authorization: string | undefined,
  saved: {
    homework: FetchedHomework[];
    exams: FetchedExam[];
    pedanet: PedanetHomework[];
    wilmaUpdatedAt: string | null;
    pedanetUpdatedAt: string | null;
  },
  now: Date,
): JsonResponse {
  if (!token) return { status: 404, body: { error: "not_found" } };
  if (!bearerMatches(authorization, token)) return { status: 401, body: { error: "unauthorized" } };
  const from = daysBefore(helsinkiDate(now), KITCHEN_HOMEWORK_DAYS);
  const byDate = <T extends { date: string }>(items: T[]) =>
    items.filter((item) => item.date >= from).sort((a, b) => a.date.localeCompare(b.date));
  return {
    status: 200,
    body: {
      fetchedAt: saved.wilmaUpdatedAt,
      homework: byDate(saved.homework).map((item) => ({
        child: item.child,
        date: item.date,
        subject: item.subject,
        text: item.homework,
        source: item.source ?? "homework",
      })),
      exams: byDate(saved.exams).map((exam) => ({
        child: exam.child,
        date: exam.date,
        subject: exam.subject,
        text: exam.description,
      })),
      classPageFetchedAt: saved.pedanetUpdatedAt,
      classPage: byDate(saved.pedanet).map((item) => ({ date: item.date, heading: item.heading, text: item.content })),
    },
  };
}
