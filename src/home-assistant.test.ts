import assert from "node:assert/strict";
import test from "node:test";
import { bearerMatches, homeAssistantSchoolDays } from "./home-assistant.js";

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
