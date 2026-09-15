import assert from "node:assert/strict";
import test from "node:test";
import { messageCalendarProjection } from "./message-calendar.js";
import { groupMessages } from "./message-group.js";
import type { FetchedMessage } from "./wilma.js";

test("one merged analysis becomes one shared event labeled for every child", () => {
  const base: FetchedMessage = {
    accountId: "school",
    studentNumber: "101",
    child: "Einari",
    messageId: 7,
    subject: "Retkipäivä",
    sender: "Opettaja",
    sentAt: new Date("2026-09-15T06:00:00Z"),
    content: "Muista eväät.",
  };
  const grouped = groupMessages([
    base,
    { ...base, studentNumber: "202", child: "Valtteri", messageId: 19 },
  ])[0]!;

  assert.deepEqual(messageCalendarProjection([{
    message: grouped,
    calendarItems: [{ title: "Retki", date: "2026-09-20", time: null, endDate: null, description: null }],
    hasOtherContent: false,
  }]), {
    items: [{
      sourceId: `wilma-message-group:${grouped.logicalMessageId}:0`,
      title: "Einari & Valtteri: Retki",
      date: "2026-09-20",
      time: null,
      endDate: null,
      description: "Wilma-viesti: Retkipäivä",
      supersededSourceIds: ["wilma-message:school:101:7:0", "wilma-message:school:202:19:0"],
    }],
    supersededSourcePrefixes: ["wilma-message:school:101:7:", "wilma-message:school:202:19:"],
  });
});

test("duplicate cleanup survives an analysis with no calendar items", () => {
  const base: FetchedMessage = {
    accountId: "school", studentNumber: "101", child: "Einari", messageId: 7,
    subject: "Tiedote", sender: "Opettaja", sentAt: new Date("2026-09-15T06:00:00Z"), content: "Ei tapahtumaa.",
  };
  const grouped = groupMessages([base, { ...base, studentNumber: "202", child: "Valtteri", messageId: 19 }])[0]!;

  assert.deepEqual(messageCalendarProjection([{
    message: grouped, calendarItems: [], hasOtherContent: true,
  }]), {
    items: [],
    supersededSourcePrefixes: ["wilma-message:school:101:7:", "wilma-message:school:202:19:"],
  });
});

test("calendar source identity survives one child's copy leaving the visible window", () => {
  const base: FetchedMessage = {
    accountId: "school", studentNumber: "101", child: "Einari", messageId: 7,
    subject: "Retki", sender: "Opettaja", sentAt: new Date("2026-09-15T06:00:00Z"), content: "Muista eväät.",
  };
  const other = { ...base, studentNumber: "202", child: "Valtteri", messageId: 19 };
  const analysis = { calendarItems: [{ title: "Retki", date: "2026-09-20", time: null, endDate: null, description: null }], hasOtherContent: false };

  const together = messageCalendarProjection([{ message: groupMessages([base, other])[0]!, ...analysis }]);
  const later = messageCalendarProjection([{ message: groupMessages([other])[0]!, ...analysis }]);

  assert.equal(together.items[0]?.sourceId, later.items[0]?.sourceId);
});
