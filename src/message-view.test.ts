import assert from "node:assert/strict";
import test from "node:test";
import { MESSAGE_CARD_CSS, renderMessageCard } from "./message-view.js";
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
  const html = renderMessageCard({ message, analysis: null, pending: false, selectionId: "opaque" });

  assert.match(html, /<details>/);
  assert.doesNotMatch(html, /<details\s+open/);
  assert.match(html, /<summary>[\s\S]*A very long message[\s\S]*<\/summary>/);
  assert.match(html, /<div class="message-body">[\s\S]*unbroken[\s\S]*<\/div>/);
  assert.match(MESSAGE_CARD_CSS, /overflow-wrap:anywhere/);
});
