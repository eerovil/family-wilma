import assert from "node:assert/strict";
import test from "node:test";
import { bearerMatches, homeAssistantSchoolDays, kitchenHomework } from "./home-assistant.js";

const saved = {
  updatedAt: "2026-10-05T03:00:00.000Z",
  schoolDays: [
    { child: "Einari", date: "2026-10-04", firstLessonStart: null, absent: false },
    { child: "Einari", date: "2026-10-05", firstLessonStart: "08:30", absent: false },
    { child: "Valtteri", date: "2026-10-05", firstLessonStart: "09:30", absent: true },
  ],
};
const now = new Date("2026-10-05T04:00:00Z");

test("without a configured token the address does not exist", () => {
  assert.equal(homeAssistantSchoolDays(null, "Bearer anything", saved, now).status, 404);
});

test("a missing or wrong token is refused", () => {
  assert.equal(homeAssistantSchoolDays("secret", undefined, saved, now).status, 401);
  assert.equal(homeAssistantSchoolDays("secret", "Bearer wrong", saved, now).status, 401);
  assert.equal(homeAssistantSchoolDays("secret", "secret", saved, now).status, 401);
  assert.equal(bearerMatches("bearer  secret ", "secret"), true);
});

test("the right token gets only first lesson and absence from today on", () => {
  const reply = homeAssistantSchoolDays("secret", "Bearer secret", saved, now);
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, {
    fetchedAt: "2026-10-05T03:00:00.000Z",
    children: {
      Einari: [{ date: "2026-10-05", firstLessonStart: "08:30", absent: false }],
      Valtteri: [{ date: "2026-10-05", firstLessonStart: "09:30", absent: true }],
    },
  });
});

const homework = {
  wilmaUpdatedAt: "2026-10-05T03:00:00.000Z",
  pedanetUpdatedAt: "2026-10-05T03:01:00.000Z",
  homework: [
    { accountId: "a", studentNumber: "123", child: "Einari", date: "2026-10-02", subject: "Matematiikka", subjectCode: "MA",
      homework: "s. 40", teacher: "Opettaja Oona", teacherCode: "OO" },
    { accountId: "a", studentNumber: "123", child: "Einari", date: "2026-09-20", subject: "Englanti", subjectCode: "EN",
      homework: "liian vanha", teacher: "T", teacherCode: "T" },
    { accountId: "a", studentNumber: "456", child: "Valtteri Vilpponen", date: "2026-10-01", subject: "Historia", subjectCode: "HI",
      homework: "Luettiin kappale 3", teacher: "T", teacherCode: "T", source: "diary" as const },
  ],
  exams: [{ sourceId: "x", child: "Einari", subject: "Biologia", date: "2026-10-09", description: "Kasvit", teacher: "T" }],
  pedanet: [{ date: "2026-10-05", heading: "ma 5.10.", content: "Lue kirjaa", sourceUrl: "https://peda.net/x",
    personalizationStatus: "unresolved" as const }],
};

test("the kitchen homework address shares the Home Assistant token rules", () => {
  assert.equal(kitchenHomework(null, "Bearer secret", homework, now).status, 404);
  assert.equal(kitchenHomework("secret", undefined, homework, now).status, 401);
  assert.equal(kitchenHomework("secret", "Bearer wrong", homework, now).status, 401);
});

test("the kitchen gets 14 days of homework, oldest first, without teachers or student numbers", () => {
  const reply = kitchenHomework("secret", "Bearer secret", homework, now);
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, {
    fetchedAt: "2026-10-05T03:00:00.000Z",
    homework: [
      { child: "Valtteri Vilpponen", date: "2026-10-01", subject: "Historia", text: "Luettiin kappale 3", source: "diary" },
      { child: "Einari", date: "2026-10-02", subject: "Matematiikka", text: "s. 40", source: "homework" },
    ],
    exams: [{ child: "Einari", date: "2026-10-09", subject: "Biologia", text: "Kasvit" }],
    classPageFetchedAt: "2026-10-05T03:01:00.000Z",
    classPage: [{ date: "2026-10-05", heading: "ma 5.10.", text: "Lue kirjaa" }],
  });
});
