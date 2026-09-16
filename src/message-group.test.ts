import assert from "node:assert/strict";
import test from "node:test";
import { groupMessages } from "./message-group.js";
import { analysisIdentity } from "./analysis.js";
import type { FetchedMessage } from "./wilma.js";

function message(overrides: Partial<FetchedMessage> = {}): FetchedMessage {
  return {
    accountId: "school",
    studentNumber: "101",
    child: "Einari",
    messageId: 7,
    subject: "Retkipäivä",
    sender: "Opettaja",
    sentAt: new Date("2026-09-15T06:00:00Z"),
    content: "Muista eväät.",
    ...overrides,
  };
}

test("identical messages on the same Helsinki date merge for display and analysis", () => {
  const grouped = groupMessages([
    message(),
    message({ studentNumber: "202", child: "Valtteri", messageId: 19, sentAt: new Date("2026-09-15T16:00:00Z") }),
  ]);

  assert.equal(grouped.length, 1);
  assert.deepEqual(grouped[0]?.children, ["Einari", "Valtteri"]);
  assert.equal(grouped[0]?.child, "Einari & Valtteri");
  assert.equal(grouped[0]?.displaySentAt.toISOString(), "2026-09-15T16:00:00.000Z");
  assert.equal(grouped[0]?.members.length, 2);
  assert.match(grouped[0]?.groupId ?? "", /^[a-f0-9]{64}$/);
});

test("grouping uses the Helsinki date rather than the UTC date", () => {
  const grouped = groupMessages([
    message({ sentAt: new Date("2026-09-14T22:30:00Z") }),
    message({ studentNumber: "202", child: "Valtteri", messageId: 19, sentAt: new Date("2026-09-15T18:00:00Z") }),
  ]);

  assert.equal(grouped.length, 1);
});

test("messages on different Helsinki dates or with different content stay separate", () => {
  const grouped = groupMessages([
    message(),
    message({ studentNumber: "202", child: "Valtteri", messageId: 19, sentAt: new Date("2026-09-15T22:00:00Z") }),
    message({ studentNumber: "303", child: "Other", messageId: 20, content: "Eri sisältö." }),
  ]);

  assert.equal(grouped.length, 3);
  assert.deepEqual(grouped.map((entry) => entry.children), [["Valtteri"], ["Einari"], ["Other"]]);
});

for (const [field, value] of [["sender", "Toinen opettaja"], ["subject", "Toinen otsikko"], ["content", "Eri sisältö."]] as const) {
  test(`messages with a different ${field} stay separate`, () => {
    const grouped = groupMessages([
      message(),
      message({ studentNumber: "202", child: "Valtteri", messageId: 19, [field]: value }),
    ]);

    assert.equal(grouped.length, 2);
  });
}

test("group identity is stable across input order and timestamp differences", () => {
  const first = message();
  const second = message({ studentNumber: "202", child: "Valtteri", messageId: 19, sentAt: new Date("2026-09-15T16:00:00Z") });

  const forward = groupMessages([first, second])[0];
  const reverse = groupMessages([{ ...second, sentAt: new Date("2026-09-15T12:00:00Z") }, first])[0];

  assert.equal(forward?.groupId, reverse?.groupId);
  assert.deepEqual(analysisIdentity(forward!), analysisIdentity(reverse!));
});

test("logical analysis identity survives one child's copy leaving the visible window", () => {
  const einari = message();
  const valtteri = message({ studentNumber: "202", child: "Valtteri", messageId: 19, sentAt: new Date("2026-09-15T16:00:00Z") });

  const together = groupMessages([einari, valtteri])[0]!;
  const later = groupMessages([valtteri])[0]!;

  assert.deepEqual(analysisIdentity(together), analysisIdentity(later));
});

test("repeated messages for only one child remain separate", () => {
  const grouped = groupMessages([
    message(),
    message({ messageId: 8, sentAt: new Date("2026-09-15T07:00:00Z") }),
  ]);

  assert.equal(grouped.length, 2);
  assert.deepEqual(grouped.map((entry) => entry.children), [["Einari"], ["Einari"]]);
});

test("identical notices merge across children but stay separate from inbox messages", () => {
  const notice = message({ sourceType: "notice" });
  const grouped = groupMessages([
    notice,
    message({ sourceType: "notice", studentNumber: "202", child: "Valtteri", messageId: 19 }),
    message({ messageId: 20 }),
  ]);

  assert.equal(grouped.length, 2);
  const noticeGroup = grouped.find((entry) => entry.sourceType === "notice");
  assert.deepEqual(noticeGroup?.children, ["Einari", "Valtteri"]);
  assert.deepEqual(noticeGroup?.members.map((member) => member.sourceType), ["notice", "notice"]);
  assert.match(noticeGroup?.groupId ?? "", /^[a-f0-9]{64}$/);
});
