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

test("Peda.net parser moves a mistyped month to the neighbouring month whose weekday fits", () => {
  // The real page on 1.10.2026 read "to 1.9." above "ke 30.9."; Thursday is 1.10.
  const result = parseRecentPedanetHomework(page(`
    to 1.9.<br>Tämän päivän tehtävä<br>
    ke 30.9.<br>Eilinen tehtävä
  `), MODULE_ID, new Date("2026-10-01T12:00:00Z"));

  assert.deepEqual(result, [
    { date: "2026-10-01", heading: "to 1.9.", content: "Tämän päivän tehtävä" },
    { date: "2026-09-30", heading: "ke 30.9.", content: "Eilinen tehtävä" },
  ]);
});

test("Peda.net parser skips only a heading that no month fits and reports it", () => {
  const skipped: string[] = [];
  const result = parseRecentPedanetHomework(
    page("ma 15.9.<br>Väärä päivä<br>ti 15.9.<br>Toinen otsikko samalle päivälle<br>ma 14.9.<br>Tehtävä"),
    MODULE_ID,
    new Date("2026-09-15T12:00:00Z"),
    (error) => skipped.push(error.message),
  );

  assert.deepEqual(result, [
    { date: "2026-09-15", heading: "ti 15.9.", content: "Toinen otsikko samalle päivälle" },
    { date: "2026-09-14", heading: "ma 14.9.", content: "Tehtävä" },
  ]);
  assert.deepEqual(skipped, ['Peda.net homework heading "ma 15.9." matched no date']);
});

test("Peda.net parser keeps the first of two headings for one date", () => {
  const skipped: string[] = [];
  const result = parseRecentPedanetHomework(
    page("ti 15.9.<br>Ensimmäinen<br>ti 15.9.<br>Toinen"),
    MODULE_ID,
    new Date("2026-09-15T12:00:00Z"),
    (error) => skipped.push(error.message),
  );

  assert.deepEqual(result, [{ date: "2026-09-15", heading: "ti 15.9.", content: "Ensimmäinen" }]);
  assert.deepEqual(skipped, ['Peda.net homework heading "ti 15.9." repeated an earlier date']);
});
