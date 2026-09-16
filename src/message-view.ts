import type { MessageAnalysis } from "./store.js";
import type { GroupedMessage } from "./message-group.js";

export const MESSAGE_CARD_CSS = ".card{max-width:100%;overflow-wrap:anywhere;word-break:break-word}.card[hidden]{display:none}.card details,.card summary{min-width:0}.card summary{cursor:pointer}.card summary h2{display:inline}.card summary .muted{margin-bottom:12px}.message-body{white-space:pre-wrap;line-height:1.45;overflow-wrap:anywhere}.calendar{margin-top:12px;padding-top:10px;border-top:1px solid #e5e7eb}.message-filters{display:grid;gap:12px;margin:18px 0 22px}.message-filter-group{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.message-filter-label{width:100%;font-size:.82rem;font-weight:700;color:#667085}.message-filter{display:inline-flex;width:auto;padding:8px 12px;border:1px solid #c7d2fe;background:#eef2ff;color:#3730a3;font-size:.9rem;font-weight:650}.message-filter[aria-pressed=true]{border-color:#1d4ed8;background:#1d4ed8;color:white}";

export const MESSAGE_FILTER_CLIENT_SCRIPT = `"use strict";
(function () {
  var buttons = Array.from(document.querySelectorAll("[data-message-filter]"));
  var cards = Array.from(document.querySelectorAll("[data-message-filters]"));
  if (!buttons.length || !cards.length) return;
  function apply() {
    var selected = buttons.filter(function (button) {
      return button.getAttribute("aria-pressed") === "true";
    }).map(function (button) { return button.getAttribute("data-message-filter"); });
    cards.forEach(function (card) {
      var values = JSON.parse(card.getAttribute("data-message-filters") || "[]");
      card.hidden = selected.length > 0 && !selected.some(function (value) {
        return values.indexOf(value) !== -1;
      });
    });
  }
  buttons.forEach(function (button) {
    button.addEventListener("click", function () {
      button.setAttribute("aria-pressed", button.getAttribute("aria-pressed") === "true" ? "false" : "true");
      apply();
    });
  });
  apply();
}());`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function filterToken(kind: "account" | "child", value: string): string {
  return `${kind}:${value}`;
}

function messageFilterValues(message: GroupedMessage): string[] {
  return [
    ...new Set(message.members.map((member) => filterToken("account", member.accountId))),
    ...message.children.map((child) => filterToken("child", child)),
  ];
}

export function renderMessageFilters(messages: GroupedMessage[]): string {
  if (!messages.length) return "";
  const accounts = [...new Set(messages.flatMap((message) => message.members.map((member) => member.accountId)))]
    .sort((left, right) => left.localeCompare(right, "fi"));
  const children = [...new Set(messages.flatMap((message) => message.children))]
    .sort((left, right) => left.localeCompare(right, "fi"));
  const group = (label: string, kind: "account" | "child", values: string[]) => values.length
    ? `<div class="message-filter-group"><span class="message-filter-label">${label}</span>${values.map((value) => `<button class="message-filter" type="button" data-message-filter="${escapeHtml(filterToken(kind, value))}" aria-pressed="false">${escapeHtml(value)}</button>`).join("")}</div>`
    : "";
  return `<section class="message-filters" aria-label="Suodata viestejä">${group("Wilma-tilit", "account", accounts)}${group("Lapset", "child", children)}</section>`;
}

export function renderMessageCard(options: {
  message: GroupedMessage;
  analysis: MessageAnalysis | null;
  pending: boolean;
}): string {
  const { message, analysis, pending } = options;
  const calendarItems = analysis?.calendarItems ?? [];
  const hasOtherContent = analysis?.hasOtherContent ?? false;
  const state = analysis ? "Analysoitu" : pending ? "Analyysi jonossa" : "Ei analysoitu";
  const items = calendarItems.length
    ? `<div class="calendar"><strong>Kalenteriin:</strong>${calendarItems.map((item) => `<div>${escapeHtml(item.date)}${item.time ? ` ${escapeHtml(item.time)}` : ""} — ${escapeHtml(item.title)}</div>`).join("")}</div>`
    : "";

  return `<article class="card${hasOtherContent ? " important" : ""}" data-message-filters="${escapeHtml(JSON.stringify(messageFilterValues(message)))}">
<div>${message.children.map((child) => `<span class="pill">${escapeHtml(child)}</span>`).join("")}${hasOtherContent ? '<span class="pill">Sisältää muutakin tärkeää</span>' : ""}</div>
<details>
<summary><h2>${escapeHtml(message.subject)}</h2><p class="muted">${escapeHtml(message.sender)} · ${escapeHtml(message.displaySentAt.toLocaleString("fi-FI", { timeZone: "Europe/Helsinki" }))} · ${state}</p></summary>
<div class="message-body">${escapeHtml(message.content)}</div>${items}
</details></article>`;
}
