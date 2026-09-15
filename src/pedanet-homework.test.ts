import assert from "node:assert/strict";
import test from "node:test";
import { parseRecentPedanetHomework } from "./pedanet-homework.js";

const MODULE_ID = "test-homework-module";

function page(content: string, id = MODULE_ID): string {
  return `<!doctype html><html><body><header>3.B 2026-2027</header>
    <article class="textmodule document" data-draft-type="published" data-id="${id}">
      <h1>LÄKSYT</h1><div class="main"><div class="content enclose">${content}</div></div>
    </article></body></html>`;
}

test("Peda.net parser returns the preceding week newest first and preserves alternatives", () => {
  const result = parseRecentPedanetHomework(page(`
    ma 7.9.<br>Liian vanha<br>
    ti 8.9.<br>Vanhin mukaan tuleva<br>
    ke 9.9.<br>Vanhin mukaan tuleva<br>
    ma 14.9.<br>Matematiikka s. 12<br>
    ti 15.9.<br>Lukuryhmä A: s. 18<br>Lukuryhmä B: s. 20<br>
    ke 16.9.<br>Tuleva tehtävä
  `), MODULE_ID, new Date("2026-09-15T12:00:00Z"));

  assert.deepEqual(result, [
    { date: "2026-09-15", heading: "ti 15.9.", content: "Lukuryhmä A: s. 18\nLukuryhmä B: s. 20" },
    { date: "2026-09-14", heading: "ma 14.9.", content: "Matematiikka s. 12" },
    { date: "2026-09-09", heading: "ke 9.9.", content: "Vanhin mukaan tuleva" },
    { date: "2026-09-08", heading: "ti 8.9.", content: "Vanhin mukaan tuleva" },
  ]);
});

test("Peda.net parser ignores an empty future placeholder", () => {
  const result = parseRecentPedanetHomework(page(`
    ti 15.9.<br>Tämän päivän tehtävä<br>
    ke 16.9.
  `), MODULE_ID, new Date("2026-09-15T12:00:00Z"));

  assert.equal(result[0]?.date, "2026-09-15");
  assert.equal(result[0]?.content, "Tämän päivän tehtävä");
});

test("Peda.net parser refuses a changed module identity", () => {
  assert.throws(
    () => parseRecentPedanetHomework(page("ti 15.9.<br>Tehtävä", "changed"), MODULE_ID, new Date("2026-09-15T12:00:00Z")),
    /identity changed/,
  );
});

test("Peda.net parser validates the weekday", () => {
  assert.throws(
    () => parseRecentPedanetHomework(page("ma 15.9.<br>Tehtävä"), MODULE_ID, new Date("2026-09-15T12:00:00Z")),
    /weekday did not match/,
  );
});
