import { load } from "cheerio";

/** How many calendar days of lesson-diary entries the homework view shows, today included. */
export const DIARY_WINDOW_DAYS = 14;

export interface DiaryGroup {
  groupId: string;
  subject: string;
  subjectCode: string;
}

export interface DiaryEntry {
  date: string;
  subject: string;
  subjectCode: string;
  teacher: string;
  text: string;
}

/**
 * Wilma's lesson diary lives on the per-group pages linked from the student home
 * page. Teachers at some schools write the homework into the diary topic instead
 * of the separate homework field that `overview.homework` reports, so the diary
 * text is shown verbatim rather than mined for a homework sentence.
 */
export function parseDiaryGroups(html: string): DiaryGroup[] {
  const $ = load(html);
  const groups = new Map<string, DiaryGroup>();
  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href") ?? "";
    const groupId = /\/groups\/(\d+)(?:[?#]|$)/.exec(href)?.[1];
    if (!groupId || groups.has(groupId)) return;
    const label = collapse($(element).text());
    if (!label) return;
    groups.set(groupId, { groupId, ...splitGroupLabel(label) });
  });
  return [...groups.values()];
}

export function parseGroupDiary(html: string, group: DiaryGroup, notBefore: string): DiaryEntry[] {
  const $ = load(html);
  const entries: DiaryEntry[] = [];
  $("table").each((_index, table) => {
    const headers = $(table).find("tr").first().find("th")
      .map((_headerIndex, cell) => collapse($(cell).text()))
      .get();
    if (!headers.includes("Tunnin aihe")) return;
    const topicIndex = headers.indexOf("Tunnin aihe");
    const dateIndex = headers.indexOf("Pvm");
    const teacherIndex = headers.indexOf("Tunnin opettaja");
    if (topicIndex < 0 || dateIndex < 0) return;
    $(table).find("tr").each((_rowIndex, row) => {
      const cells = $(row).find("td");
      if (!cells.length) return;
      const date = finnishDateToIso(collapse($(cells.get(dateIndex)).text()));
      if (!date || date < notBefore) return;
      const topicCell = $(cells.get(topicIndex)).clone();
      topicCell.find("br").replaceWith("\n");
      const text = topicCell.text().replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
      if (!text) return;
      entries.push({
        date,
        subject: group.subject,
        subjectCode: group.subjectCode,
        teacher: teacherIndex >= 0 ? collapse($(cells.get(teacherIndex)).text()) : "",
        text,
      });
    });
  });
  return entries;
}

/** Oldest date the homework view keeps, as a Helsinki calendar date. */
export function diaryCutoff(now: Date, days = DIARY_WINDOW_DAYS): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Helsinki",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return start.toISOString().slice(0, 10);
}

/** Group labels read "MA 3A MA06 : Matematiikka"; the part after the colon is the subject. */
function splitGroupLabel(label: string): { subject: string; subjectCode: string } {
  const separator = label.indexOf(":");
  if (separator < 0) return { subject: label, subjectCode: label };
  const subjectCode = label.slice(0, separator).trim();
  const subject = label.slice(separator + 1).trim();
  if (!subject) return { subject: subjectCode, subjectCode };
  return { subject, subjectCode: subjectCode || subject };
}

function finnishDateToIso(value: string): string | null {
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
