import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { HomeworkCacheStore, homeworkCacheIdentity, wilmaHomeworkCacheIdentity } from "./homework-cache.js";

test("homework cache survives store recreation and is isolated by configuration identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "family-wilma-homework-cache-"));
  const identities = { wilma: homeworkCacheIdentity(["household-a"]), pedanet: homeworkCacheIdentity(["page-a"]), exams: homeworkCacheIdentity(["exams"]) };
  const updatedAt = "2026-09-15T12:00:00.000Z";
  try {
    const first = new HomeworkCacheStore(dir, identities);
    first.putWilma([{
      accountId: "school",
      studentNumber: "1",
      child: "Child",
      date: "2026-09-15",
      subject: "Math",
      subjectCode: "MA",
      homework: "Page 12",
      teacher: "Teacher",
      teacherCode: "TEA",
    }], updatedAt);
    first.putPedanet([{
      date: "2026-09-15",
      heading: "ti 15.9.",
      content: "Task",
      sourceUrl: "https://example.test/homework",
      personalizationStatus: "unresolved",
    }], updatedAt);

    const restarted = new HomeworkCacheStore(dir, identities);
    assert.equal(restarted.getWilma()?.value[0]?.homework, "Page 12");
    assert.equal(restarted.getPedanet()?.value[0]?.content, "Task");
    assert.equal(restarted.getWilma()?.updatedAt, updatedAt);
    assert.equal(statSync(join(dir, "family-wilma.sqlite")).mode & 0o777, 0o600);

    const changedConfig = new HomeworkCacheStore(dir, {
      wilma: homeworkCacheIdentity(["household-b"]),
      pedanet: homeworkCacheIdentity(["page-b"]),
      exams: homeworkCacheIdentity(["exams-b"]),
    });
    assert.equal(changedConfig.getWilma(), null);
    assert.equal(changedConfig.getPedanet(), null);

    const db = new DatabaseSync(join(dir, "family-wilma.sqlite"));
    db.prepare("UPDATE homework_cache SET payload_json = 'not-json' WHERE source = 'wilma'").run();
    db.close();
    assert.equal(first.getWilma(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Wilma cache identity changes with the account principal but never needs its password", () => {
  const account = {
    id: "school",
    baseUrl: "https://school.inschool.fi",
    username: "guardian-a",
    password: "password-a",
    profiles: [],
  };
  const original = wilmaHomeworkCacheIdentity([account]);
  assert.notEqual(wilmaHomeworkCacheIdentity([{ ...account, username: "guardian-b" }]), original);
  assert.equal(wilmaHomeworkCacheIdentity([{ ...account, password: "password-b" }]), original);
});
