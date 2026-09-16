import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { MESSAGE_STATUS_CLIENT_SCRIPT, transientStatus } from "./message-status.js";

test("terminal status expires ten seconds after completion", () => {
  assert.deepEqual(transientStatus("batch:1", "2026-09-16T08:00:00.000Z", Date.parse("2026-09-16T08:00:05.000Z")), {
    id: "batch:1",
    hideAfterMs: 5_000,
  });
  assert.equal(transientStatus("batch:1", "2026-09-16T08:00:00.000Z", Date.parse("2026-09-16T08:00:10.000Z")), null);
});

test("terminal status hides on timeout and does not reappear after reload", () => {
  class Element {
    removed = false;
    constructor(private readonly attributes: Record<string, string>) {}
    getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
    remove(): void { this.removed = true; }
  }
  const stored = new Map<string, string>();
  const delays: number[] = [];
  const sessionStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); },
  };
  const first = new Element({ "data-transient-status": "batch:1", "data-status-hide-after": "5000" });
  runInNewContext(MESSAGE_STATUS_CLIENT_SCRIPT, {
    document: { querySelectorAll: () => [first] },
    sessionStorage,
    setTimeout: (callback: () => void, delay: number) => { delays.push(delay); callback(); },
  });
  assert.equal(first.removed, true);
  assert.deepEqual(delays, [5_000]);

  const reloaded = new Element({ "data-transient-status": "batch:1", "data-status-hide-after": "5000" });
  runInNewContext(MESSAGE_STATUS_CLIENT_SCRIPT, {
    document: { querySelectorAll: () => [reloaded] },
    sessionStorage,
    setTimeout: () => { throw new Error("already-seen status must not schedule another timer"); },
  });
  assert.equal(reloaded.removed, true);
});
