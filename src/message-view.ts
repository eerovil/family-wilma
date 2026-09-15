import type { MessageAnalysis } from "./store.js";
import type { FetchedMessage } from "./wilma.js";

export const MESSAGE_CARD_CSS = ".card{max-width:100%;overflow-wrap:anywhere;word-break:break-word}.card details,.card summary{min-width:0}.card summary{cursor:pointer}.card summary h2{display:inline}.card summary .muted{margin-bottom:12px}.message-body{white-space:pre-wrap;line-height:1.45;overflow-wrap:anywhere}.calendar{margin-top:12px;padding-top:10px;border-top:1px solid #e5e7eb}";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

export function renderMessageCard(options: {
  message: FetchedMessage;
  analysis: MessageAnalysis | null;
  pending: boolean;
  selectionId: string;
}): string {
  const { message, analysis, pending, selectionId } = options;
  const calendarItems = analysis?.calendarItems ?? [];
  const hasOtherContent = analysis?.hasOtherContent ?? false;
  const state = analysis ? "Analysoitu" : pending ? "Analyysi jonossa" : "Ei analysoitu";
  const selection = analysis || pending
    ? ""
    : `<label class="select"><input type="checkbox" name="message" value="${escapeHtml(selectionId)}"> Valitse analysoitavaksi</label>`;
  const items = calendarItems.length
    ? `<div class="calendar"><strong>Kalenteriin:</strong>${calendarItems.map((item) => `<div>${escapeHtml(item.date)}${item.time ? ` ${escapeHtml(item.time)}` : ""} — ${escapeHtml(item.title)}</div>`).join("")}</div>`
    : "";

  return `<article class="card${hasOtherContent ? " important" : ""}">
<div><span class="pill">${escapeHtml(message.child)}</span>${hasOtherContent ? '<span class="pill">Sisältää muutakin tärkeää</span>' : ""}</div>
<details>
<summary><h2>${escapeHtml(message.subject)}</h2><p class="muted">${escapeHtml(message.sender)} · ${escapeHtml(message.sentAt.toLocaleString("fi-FI", { timeZone: "Europe/Helsinki" }))} · ${state}</p></summary>
<div class="message-body">${escapeHtml(message.content)}</div>${items}
</details>
${selection}</article>`;
}
