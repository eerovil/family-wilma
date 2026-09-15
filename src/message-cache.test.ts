import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MessageCacheStore } from "./message-cache.js";

function message(subject: string) {
  return {
    accountId: "school", studentNumber: "1", child: "Child", messageId: 7,
    subject, sender: "Teacher", sentAt: new Date("2026-09-15T10:00:00.000Z"), content: "Body",
  };
}

test("message cache survives restart, revives dates, and is isolated by household", () => {
  const dir = mkdtempSync(join(tmpdir(), "family-wilma-message-cache-"));
  try {
    const first = new MessageCacheStore(dir, "household-a");
    first.put({ messages: [message("Stored")], structuredCalendarItems: [] }, "2026-09-15T12:00:00.000Z");

    const restarted = new MessageCacheStore(dir, "household-a").get();
    assert.equal(restarted?.messages[0]?.subject, "Stored");
    assert.ok(restarted?.messages[0]?.sentAt instanceof Date);
    assert.equal(restarted?.messages[0]?.sentAt.toISOString(), "2026-09-15T10:00:00.000Z");
    assert.equal(restarted?.updatedAt, "2026-09-15T12:00:00.000Z");
    assert.equal(new MessageCacheStore(dir, "household-b").get(), null);

    const db = new DatabaseSync(join(dir, "family-wilma.sqlite"));
    db.prepare("UPDATE message_cache SET payload_json = 'not-json'").run();
    db.close();
    assert.equal(first.get(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
