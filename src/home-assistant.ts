import { createHash, timingSafeEqual } from "node:crypto";
import { helsinkiDate, type SchoolDay } from "./school-days.js";

export const HOME_ASSISTANT_SCHOOL_DAYS_PATH = "/api/home-assistant/school-days";

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
