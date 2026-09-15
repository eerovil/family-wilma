import assert from "node:assert/strict";
import test from "node:test";
import { MESSAGE_CARD_CSS, renderMessageCard } from "./message-view.js";
import { groupMessages } from "./message-group.js";
import type { FetchedMessage } from "./wilma.js";

const message: FetchedMessage = {
  accountId: "school",
  studentNumber: "101",
  child: "Child",
  messageId: 7,
  subject: "A very long message",
  sender: "Teacher",
  sentAt: new Date("2026-09-15T05:00:00Z"),
  content: `Read https://example.test/${"unbroken".repeat(40)}`,
};

test("message cards are collapsed by default and wrap unbroken content", () => {
  const html = renderMessageCard({ message: groupMessages([message])[0]!, analysis: null, pending: false });

  assert.match(html, /<details>/);
  assert.doesNotMatch(html, /<details\s+open/);
  assert.match(html, /<summary>[\s\S]*A very long message[\s\S]*<\/summary>/);
  assert.match(html, /<div class="message-body">[\s\S]*unbroken[\s\S]*<\/div>/);
  assert.match(MESSAGE_CARD_CSS, /overflow-wrap:anywhere/);
  assert.doesNotMatch(html, /checkbox|Valitse analysoitavaksi/);
});

test("merged message cards show every affected child once", () => {
  const html = renderMessageCard({
    message: groupMessages([
      message,
      { ...message, studentNumber: "202", child: "Valtteri", messageId: 8 },
      { ...message, studentNumber: "303", child: "Child", messageId: 9 },
    ])[0]!,
    analysis: null,
    pending: false,
  });

  assert.equal((html.match(/>Child<\/span>/g) ?? []).length, 1);
  assert.equal((html.match(/>Valtteri<\/span>/g) ?? []).length, 1);
});
