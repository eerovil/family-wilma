import assert from "node:assert/strict";
import test from "node:test";
import { diaryCutoff, parseDiaryGroups, parseGroupDiary } from "./wilma-diary.js";

const HOME_PAGE = `<!doctype html><html><body>
  <a href="/!0423234/messages">Viestit</a>
  <a href="/!0423234/groups/81448">MA 3A MA06 : Matematiikka &#160;</a>
  <a href="/!0423234/groups/81361">AI 3A AI06 : Suomen kieli ja kirjallisuus</a>
  <a href="/!0423234/groups/81448">MA 3A MA06 : Matematiikka</a>
  <a href="/!0423234/groups/81436">LI 3A LI06</a>
</body></html>`;

const GROUP_PAGE = `<!doctype html><html><body>
  <table class="table">
    <tr><th>Opettajat</th><th>Huoneet</th><th>Kurssi</th></tr>
    <tr><td>RSH</td><td>Ei määritelty</td><td>MA06 (Matematiikka)</td></tr>
  </table>
  <table class="table gridtable">
    <tr><th>Pvm</th><th>Aihe</th><th>Kokeen lisätiedot</th><th>Arvosana</th></tr>
    <tr><td>10.09.2026</td><td>Yhteen- ja vähennyslasku</td><td>s. 4-61</td><td>8-</td></tr>
  </table>
  <table class="table gridtable">
    <tr><th>Pvm</th><th>Tuntinro</th><th>Tunnin aihe</th><th>Tunnin opettaja</th></tr>
    <tr><td>16.09.2026</td><td></td><td>kertotaulut s.74-77<br>kotona s.77/1,2,3</td>
      <td><a href="/!0423234/profiles/teachers/131" class="ope">Helena Räty-Simonen</a></td></tr>
    <tr><td>15.09.2026</td><td>1</td><td>   s. 70-73   kotona s. 73/1,2,3 </td><td>Helena Räty-Simonen</td></tr>
    <tr><td>14.09.2026</td><td></td><td>   </td><td>Helena Räty-Simonen</td></tr>
    <tr><td>26.08.2026</td><td></td><td>yhteenlasku s. 34-37</td><td>Helena Räty-Simonen</td></tr>
  </table>
</body></html>`;

const MATH = { groupId: "81448", subject: "Matematiikka", subjectCode: "MA 3A MA06" };

test("group links are read once each and split into subject and code", () => {
  assert.deepEqual(parseDiaryGroups(HOME_PAGE), [
    MATH,
    { groupId: "81361", subject: "Suomen kieli ja kirjallisuus", subjectCode: "AI 3A AI06" },
    { groupId: "81436", subject: "LI 3A LI06", subjectCode: "LI 3A LI06" },
  ]);
});

test("lesson diary rows are read verbatim and other group tables are ignored", () => {
  const entries = parseGroupDiary(GROUP_PAGE, MATH, "2026-09-10");
  assert.deepEqual(entries, [
    {
      date: "2026-09-16",
      subject: "Matematiikka",
      subjectCode: "MA 3A MA06",
      teacher: "Helena Räty-Simonen",
      text: "kertotaulut s.74-77\nkotona s.77/1,2,3",
    },
    {
      date: "2026-09-15",
      subject: "Matematiikka",
      subjectCode: "MA 3A MA06",
      teacher: "Helena Räty-Simonen",
      text: "s. 70-73 kotona s. 73/1,2,3",
    },
  ]);
});

test("the exam grade row never leaks into the diary", () => {
  const entries = parseGroupDiary(GROUP_PAGE, MATH, "2026-01-01");
  assert.equal(entries.length, 3);
  assert.ok(!entries.some((entry) => entry.text.includes("Yhteen- ja vähennyslasku")));
});

test("a group page with no diary table yields nothing", () => {
  assert.deepEqual(parseGroupDiary("<html><body><p>Ei merkintöjä</p></body></html>", MATH, "2026-01-01"), []);
});

test("the cutoff keeps fourteen Helsinki days including today", () => {
  assert.equal(diaryCutoff(new Date("2026-09-16T05:00:00Z")), "2026-09-03");
  // Late evening UTC is already the next day in Helsinki.
  assert.equal(diaryCutoff(new Date("2026-09-16T22:30:00Z")), "2026-09-04");
});
