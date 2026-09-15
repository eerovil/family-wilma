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

test("homework view renders Peda.net first and one newest-first Wilma list", () => {
  const html = renderHomeworkContent({
    pedanet: [{
      date: "2026-09-15",
      heading: "ti 15.9.",
      content: "A: s. 18\nB: s. 20",
      sourceUrl: "https://example.test/homework",
      personalizationStatus: "unresolved",
    }, {
      date: "2026-09-14",
      heading: "ma 14.9.",
      content: "Older Peda task",
      sourceUrl: "https://example.test/homework",
      personalizationStatus: "unresolved",
    }],
    pedanetSourceUrl: "https://example.test/homework",
    homework: [
      homework({ child: "Einari", date: "2026-09-15", homework: "Newest <task>" }),
      homework({ child: "Valtteri", date: "2026-09-14", homework: "Older task" }),
    ],
  });

  assert.ok(html.indexOf("Einari · Peda.net") < html.indexOf("Newest &lt;task&gt;"));
  assert.ok(html.indexOf("Newest &lt;task&gt;") < html.indexOf("Older task"));
  assert.match(html, /A: s\. 18\nB: s\. 20/);
  assert.ok(html.indexOf("ti 15.9.") < html.indexOf("ma 14.9."));
  assert.match(HOMEWORK_VIEW_CSS, /overflow-wrap:anywhere/);
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
