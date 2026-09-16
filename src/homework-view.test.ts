import assert from "node:assert/strict";
import test from "node:test";
import { HOMEWORK_VIEW_CSS, renderHomeworkContent } from "./homework-view.js";
import type { FetchedHomework } from "./wilma.js";

function homework(overrides: Partial<FetchedHomework>): FetchedHomework {
  return {
    accountId: "school",
    studentNumber: "1",
    child: "Child",
    date: "2026-09-15",
    subject: "Math",
    subjectCode: "MA",
    homework: "Page 12",
    teacher: "Teacher",
    teacherCode: "TEA",
    ...overrides,
  };
}

test("homework view combines Peda.net and Wilma into one newest-first timeline", () => {
  const html = renderHomeworkContent({
    pedanet: [{
      date: "2026-09-15",
      heading: "ti 15.9.",
      content: "A: s. 18\nB: s. 20",
      sourceUrl: "https://example.test/homework",
      personalizationStatus: "unresolved",
    }, {
      date: "2026-09-13",
      heading: "su 13.9.",
      content: "Older Peda task",
      sourceUrl: "https://example.test/homework",
      personalizationStatus: "unresolved",
    }],
    pedanetSourceUrl: "https://example.test/homework",
    homework: [
      homework({ child: "Einari", date: "2026-09-15", homework: "Newest <task>" }),
      homework({ child: "Valtteri", date: "2026-09-12", homework: "Oldest task" }),
    ],
  });

  assert.ok(html.indexOf("Einari · Peda.net") < html.indexOf("Newest &lt;task&gt;"));
  assert.ok(html.indexOf("Newest &lt;task&gt;") < html.indexOf("Older Peda task"));
  assert.ok(html.indexOf("Older Peda task") < html.indexOf("Oldest task"));
  assert.match(html, /A: s\. 18\nB: s\. 20/);
  assert.match(HOMEWORK_VIEW_CSS, /overflow-wrap:anywhere/);
});

test("each day gets one heading and Peda.net dates sit where every other card keeps them", () => {
  const html = renderHomeworkContent({
    pedanet: [{
      date: "2026-09-15",
      heading: "ti 15.9.",
      content: "Peda task",
      sourceUrl: "https://example.test/homework",
      personalizationStatus: "unresolved",
    }],
    pedanetSourceUrl: "https://example.test/homework",
    homework: [
      homework({ date: "2026-09-15", subject: "Math", homework: "Same day" }),
      homework({ date: "2026-09-14", subject: "Finnish", homework: "Day before" }),
    ],
  });

  assert.deepEqual(html.match(/<h2 class="homework-day">[^<]*<\/h2>/g), [
    '<h2 class="homework-day">ti 15.9.2026</h2>',
    '<h2 class="homework-day">ma 14.9.2026</h2>',
  ]);
  // The Peda.net card reads its date from the same muted meta line as the rest.
  assert.match(html, /<h3>Läksyt<\/h3><p class="muted homework-meta">15\.9\.2026<\/p>/);
  assert.ok(!html.includes("ti 15.9.<"));
  assert.ok(html.indexOf("Peda task") < html.indexOf("Same day"));
  assert.ok(html.indexOf("Same day") < html.indexOf("ma 14.9.2026"));
});

test("lesson diary entries share the timeline and stay behind same-day homework", () => {
  const html = renderHomeworkContent({
    pedanet: [],
    pedanetSourceUrl: null,
    homework: [
      homework({ child: "Valtteri", date: "2026-09-16", subject: "Matematiikka", homework: "Diary text", source: "diary" }),
      homework({ child: "Valtteri", date: "2026-09-16", subject: "Englanti", homework: "Real homework", source: "homework" }),
      homework({ child: "Valtteri", date: "2026-09-15", subject: "Äidinkieli", homework: "Older diary", source: "diary" }),
    ],
  });
  assert.ok(html.indexOf("Real homework") < html.indexOf("Diary text"));
  assert.ok(html.indexOf("Diary text") < html.indexOf("Older diary"));
  assert.equal(html.match(/Tuntipäiväkirja/g)?.length, 2);
  assert.ok(!html.slice(html.indexOf("Real homework") - 400, html.indexOf("Real homework")).includes("Tuntipäiväkirja"));
});

test("Peda.net error does not hide Wilma homework", () => {
  const html = renderHomeworkContent({
    pedanet: [],
    pedanetError: true,
    pedanetSourceUrl: "https://example.test/homework",
    homework: [homework({ homework: "Still visible" })],
  });
  assert.match(html, /Peda\.net-kotitehtäviä ei voitu ladata/);
  assert.match(html, /Still visible/);
  assert.match(html, /https:\/\/example\.test\/homework/);
});
