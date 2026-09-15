import assert from "node:assert/strict";
import test from "node:test";
import { cacheIsFresh } from "./cache-freshness.js";

const now = new Date("2026-09-15T12:15:00.000Z");

test("cache is fresh for less than fifteen minutes only", () => {
  assert.equal(cacheIsFresh("2026-09-15T12:00:01.000Z", now), true);
  assert.equal(cacheIsFresh("2026-09-15T12:00:00.000Z", now), false);
  assert.equal(cacheIsFresh("not-a-date", now), false);
  assert.equal(cacheIsFresh("2026-09-15T12:15:01.000Z", now), false);
  assert.equal(cacheIsFresh(null, now), false);
});
