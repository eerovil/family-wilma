import type { PedanetHomework } from "./pedanet-homework.js";
import type { FetchedHomework } from "./wilma.js";

export const HOMEWORK_VIEW_CSS = ".homework-card{overflow-wrap:anywhere}.homework-card h2{margin:.45rem 0}.homework-body{white-space:pre-wrap;line-height:1.45}.source-card{border-left:6px solid #2563eb}.homework-meta{margin:.35rem 0 0}";

export function renderHomeworkContent(options: {
  homework: FetchedHomework[];
  wilmaError?: boolean;
  pedanet: PedanetHomework | null;
  pedanetError?: boolean;
  pedanetSourceUrl: string | null;
}): string {
  const peda = options.pedanet
    ? `<article class="card homework-card source-card"><div><span class="pill">Einari · Peda.net</span></div><h2>${escapeHtml(options.pedanet.heading)}</h2><div class="homework-body">${escapeHtml(options.pedanet.content)}</div><p class="muted homework-meta">Luokan sivulla voi olla vaihtoehtoisia tehtäviä eri ryhmille. <a class="toplink" href="${escapeHtml(options.pedanet.sourceUrl)}" rel="noopener noreferrer">Avaa lähde</a></p></article>`
    : `<article class="card homework-card source-card"><strong>Einari · Peda.net</strong><p class="muted">${options.pedanetError ? "Peda.net-kotitehtäviä ei voitu ladata." : "Peda.net-kotitehtäviä ei ole määritetty."}${options.pedanetSourceUrl ? ` <a class="toplink" href="${escapeHtml(options.pedanetSourceUrl)}" rel="noopener noreferrer">Avaa lähde</a>` : ""}</p></article>`;
  const wilmaStatus = options.wilmaError
    ? '<div class="error">Wilman kotitehtäviä ei voitu ladata.</div>'
    : "";
  const cards = options.homework.map((item) => `<article class="card homework-card"><div><span class="pill">${escapeHtml(item.child)}</span></div><h2>${escapeHtml(item.subject || item.subjectCode || "Kotitehtävä")}</h2><p class="muted homework-meta">${escapeHtml(formatDate(item.date))}${item.teacher ? ` · ${escapeHtml(item.teacher)}` : ""}</p><div class="homework-body">${escapeHtml(item.homework)}</div></article>`).join("");
  const empty = !options.wilmaError && !cards ? '<p class="muted">Wilmassa ei ole kotitehtäviä.</p>' : "";
  return `${peda}${wilmaStatus}${cards}${empty}`;
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
