import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AnalysisStore } from "./store.js";

test("analysis cache reuses unchanged content and misses changed content", () => {
  const dir = mkdtempSync(join(tmpdir(), "family-wilma-"));
  try {
    const store = new AnalysisStore(dir);
    const identity = {
      accountId: "school-a",
      studentNumber: "42",
      messageId: 123,
      content: "Retki tiistaina",
      analyzerVersion: "v1",
    };
    assert.equal(store.get(identity), null);
    store.put(identity, {
      calendarItems: [{ title: "Retki", date: "2026-09-15", time: null, endDate: null, description: null }],
      hasOtherContent: true,
    });
    assert.equal(store.get(identity)?.calendarItems[0]?.title, "Retki");
    assert.equal(store.get({ ...identity, content: "Retki keskiviikkona" }), null);
    assert.equal(store.get({ ...identity, analyzerVersion: "v2" }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
