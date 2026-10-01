import assert from "node:assert/strict";
import test from "node:test";
import { calendarSyncMustWait, homeworkMustWait, messageRefreshBlocked, type WilmaJobStates } from "./wilma-turn.js";

const idle: WilmaJobStates = { homework: { state: "idle", waiting: false }, messages: "ready", sync: "idle" };

test("a running analysis batch does not hold homework or message refreshes", () => {
  const analyzing = { ...idle, sync: "analyzing" as const };
  assert.equal(homeworkMustWait(analyzing), false);
  assert.equal(messageRefreshBlocked(analyzing), false);
});

test("the calendar sync step still holds both refreshes", () => {
  const syncing = { ...idle, sync: "syncing" as const };
  assert.equal(homeworkMustWait(syncing), true);
  assert.equal(messageRefreshBlocked(syncing), true);
});

test("homework waits for a message load, and a message refresh is refused during homework", () => {
  assert.equal(homeworkMustWait({ ...idle, messages: "fetching" }), true);
  assert.equal(messageRefreshBlocked({ ...idle, homework: { state: "running", waiting: false } }), true);
});

test("the calendar sync waits only for a job that is reading Wilma", () => {
  assert.equal(calendarSyncMustWait(idle), false);
  assert.equal(calendarSyncMustWait({ ...idle, homework: { state: "running", waiting: false } }), true);
  assert.equal(calendarSyncMustWait({ ...idle, homework: { state: "running", waiting: true } }), false);
  assert.equal(calendarSyncMustWait({ ...idle, messages: "fetching" }), true);
});
