import type { PedanetHomework } from "./pedanet-homework.js";
import { renderCalendarChoice } from "./message-view.js";
import type { FetchedExam, FetchedHomework } from "./wilma.js";

export const HOMEWORK_VIEW_CSS = ".homework-card{overflow-wrap:anywhere}.homework-card h3{margin:.45rem 0;font-size:1.15rem}.homework-body{white-space:pre-wrap;line-height:1.45}.source-card{border-left:6px solid #2563eb}.homework-meta{margin:.35rem 0 0}.diary-pill{margin-left:.35rem;background:#e5e7eb;color:#374151}.homework-day{margin:1.8rem 0 .2rem;font-size:1rem;color:#475569;text-transform:lowercase}.exam-heading{margin:.2rem 0;font-size:1.15rem}";

/** Upcoming exams, each a checkbox that decides whether sync writes it. */
export function renderExamSection(options: {
  exams: FetchedExam[];
  droppedSourceIds: ReadonlySet<string>;
}): string {
  if (!options.exams.length) return "";
  const rows = options.exams.map((exam) => renderCalendarChoice({
    sourceId: exam.sourceId,
    label: `${formatDate(exam.date)} · ${exam.child} · ${exam.subject}${exam.description ? ` — ${exam.description}` : ""}`,
    dropped: options.droppedSourceIds.has(exam.sourceId),
    returnTo: "/homework",
  })).join("");
  return `<article class="card homework-card"><h2 class="exam-heading">Kokeet</h2>`
    + `<p class="muted homework-meta">Rasti ratkaisee, kirjoittaako kalenterisynkkaus kokeen.</p>${rows}</article>`;
}

export function renderHomeworkContent(options: {
  homework: FetchedHomework[];
  wilmaError?: boolean;
  pedanet: PedanetHomework[];
  pedanetError?: boolean;
  pedanetSourceUrl: string | null;
}): string {
  const pedaStatus = options.pedanet.length
    ? ""
    : `<article class="card homework-card source-card"><strong>Einari · Peda.net</strong><p class="muted">${options.pedanetError ? "Peda.net-kotitehtäviä ei voitu ladata." : "Peda.net-kotitehtäviä ei ole määritetty."}${options.pedanetSourceUrl ? ` <a class="toplink" href="${escapeHtml(options.pedanetSourceUrl)}" rel="noopener noreferrer">Avaa lähde</a>` : ""}</p></article>`;
  const wilmaStatus = options.wilmaError
    ? '<div class="error">Wilman kotitehtäviä ei voitu ladata.</div>'
    : "";
  const cards = [
    ...options.pedanet.map((item, index) => ({
      date: item.date,
      sourceOrder: 0,
      html: `<article class="card homework-card source-card"><div><span class="pill">Einari · Peda.net</span></div><h3>Läksyt</h3><p class="muted homework-meta">${escapeHtml(formatDate(item.date))}</p><div class="homework-body">${escapeHtml(item.content)}</div>${index === 0 ? `<p class="muted homework-meta">Luokan sivulla voi olla vaihtoehtoisia tehtäviä eri ryhmille. <a class="toplink" href="${escapeHtml(item.sourceUrl)}" rel="noopener noreferrer">Avaa lähde</a></p>` : ""}</article>`,
    })),
    ...options.homework.map((item) => ({
      date: item.date,
      sourceOrder: item.source === "diary" ? 2 : 1,
      html: `<article class="card homework-card"><div><span class="pill">${escapeHtml(item.child)}</span>${item.source === "diary" ? '<span class="pill diary-pill">Tuntipäiväkirja</span>' : ""}</div><h3>${escapeHtml(item.subject || item.subjectCode || "Kotitehtävä")}</h3><p class="muted homework-meta">${escapeHtml(formatDate(item.date))}${item.teacher ? ` · ${escapeHtml(item.teacher)}` : ""}</p><div class="homework-body">${escapeHtml(item.homework)}</div></article>`,
    })),
  ].sort((left, right) => right.date.localeCompare(left.date) || left.sourceOrder - right.sourceOrder)
    .map((item, index, all) => (index === 0 || all[index - 1]!.date !== item.date
      ? `<h2 class="homework-day">${escapeHtml(formatDayHeading(item.date))}</h2>`
      : "") + item.html)
    .join("");
  const empty = !options.wilmaError && !cards ? '<p class="muted">Wilmassa ei ole kotitehtäviä.</p>' : "";
  return `${pedaStatus}${wilmaStatus}${cards}${empty}`;
}

/** Group heading, always weekday plus date so it never depends on "today". */
function formatDayHeading(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("fi-FI", {
      weekday: "short",
      day: "numeric",
      month: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(date);
}

function formatDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("fi-FI", { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}
