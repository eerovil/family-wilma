import assert from "node:assert/strict";
import test from "node:test";
import type { LessonNote, ScheduleLesson } from "@wilm-ai/wilma-client";
import { firstLessonStarts, isMorningAbsence, mergeSchoolDays, schoolDayWindow } from "./school-days.js";

function note(start: string | null, typeLabel = "Poissa -terveydelliset syyt"): LessonNote {
  return { date: "2026-09-29", start, end: null, subject: "MA", typeLabel, typeClass: "at-tp190", teacher: "T" };
}

test("the window is today plus seven Helsinki days and the two Wilma weeks they touch", () => {
  // 22:30 UTC on Sunday is already Monday in Helsinki.
  const { dates, weekDates } = schoolDayWindow(new Date("2026-10-04T22:30:00Z"));
  assert.equal(dates[0], "2026-10-05");
  assert.equal(dates.at(-1), "2026-10-12");
  assert.deepEqual(weekDates, ["2026-10-05", "2026-10-12"]);
  assert.deepEqual(schoolDayWindow(new Date("2026-10-08T06:00:00Z")).weekDates, ["2026-10-05", "2026-10-12"]);
});

test("first lesson start is the earliest valid start per date", () => {
  const lesson = (date: string, start: string) => ({ date, start, end: "15:00" }) as ScheduleLesson;
  const starts = firstLessonStarts([lesson("2026-10-05", "09:30"), lesson("2026-10-05", "08:30"), lesson("2026-10-06", "bad")]);
  assert.deepEqual([...starts], [["2026-10-05", "08:30"]]);
});

test("a morning absence is an absence mark in or before the first lesson's hour", () => {
  // Wilma's attendance grid reports whole hours: 08:00 for an 08:30 lesson.
  assert.equal(isMorningAbsence(note("08:00"), "08:30"), true);
  assert.equal(isMorningAbsence(note("12:00"), "08:30"), false);
  assert.equal(isMorningAbsence(note(null), "08:30"), false);
  assert.equal(isMorningAbsence(note("08:00", "Myöhässä"), "08:30"), false);
});

test("the same child from two accounts merges to the earliest lesson and any absence", () => {
  const merged = mergeSchoolDays([
    { child: "Einari", date: "2026-10-05", firstLessonStart: "09:30", absent: false },
    { child: "Einari", date: "2026-10-05", firstLessonStart: "08:30", absent: true },
    { child: "Einari", date: "2026-10-06", firstLessonStart: null, absent: false },
  ]);
  assert.deepEqual(merged, [
    { child: "Einari", date: "2026-10-05", firstLessonStart: "08:30", absent: true },
    { child: "Einari", date: "2026-10-06", firstLessonStart: null, absent: false },
  ]);
});
