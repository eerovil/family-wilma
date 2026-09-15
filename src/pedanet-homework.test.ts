import assert from "node:assert/strict";
import test from "node:test";
import { parseLatestPedanetHomework } from "./pedanet-homework.js";

const MODULE_ID = "test-homework-module";

function page(content: string, id = MODULE_ID): string {
  return `<!doctype html><html><body><header>3.B 2026-2027</header>
    <article class="textmodule document" data-draft-type="published" data-id="${id}">
      <h1>LÄKSYT</h1><div class="main"><div class="content enclose">${content}</div></div>
    </article></body></html>`;
}

test("Peda.net parser returns the newest current block and preserves alternatives", () => {
  const result = parseLatestPedanetHomework(page(`
    ma 14.9.<br>Matematiikka s. 12<br>
    ti 15.9.<br>Lukuryhmä A: s. 18<br>Lukuryhmä B: s. 20<br>
    ke 16.9.<br>Tuleva tehtävä
  `), MODULE_ID, new Date("2026-09-15T12:00:00Z"));

  assert.deepEqual(result, {
    date: "2026-09-15",
    heading: "ti 15.9.",
    content: "Lukuryhmä A: s. 18\nLukuryhmä B: s. 20",
  });
});

test("Peda.net parser ignores an empty future placeholder", () => {
  const result = parseLatestPedanetHomework(page(`
    ti 15.9.<br>Tämän päivän tehtävä<br>
    ke 16.9.
  `), MODULE_ID, new Date("2026-09-15T12:00:00Z"));

  assert.equal(result.date, "2026-09-15");
  assert.equal(result.content, "Tämän päivän tehtävä");
});

test("Peda.net parser refuses a changed module identity", () => {
  assert.throws(
    () => parseLatestPedanetHomework(page("ti 15.9.<br>Tehtävä", "changed"), MODULE_ID, new Date("2026-09-15T12:00:00Z")),
    /identity changed/,
  );
});

test("Peda.net parser validates the weekday", () => {
  assert.throws(
    () => parseLatestPedanetHomework(page("ma 15.9.<br>Tehtävä"), MODULE_ID, new Date("2026-09-15T12:00:00Z")),
    /weekday did not match/,
  );
});
