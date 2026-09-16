import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { MESSAGE_CARD_CSS, MESSAGE_FILTER_CLIENT_SCRIPT, renderMessageCard, renderMessageFilters } from "./message-view.js";
import { groupMessages } from "./message-group.js";
import type { FetchedMessage } from "./wilma.js";

const message: FetchedMessage = {
  accountId: "school",
  studentNumber: "101",
  child: "Child",
  messageId: 7,
  subject: "A very long message",
  sender: "Teacher",
  sentAt: new Date("2026-09-15T05:00:00Z"),
  content: `Read https://example.test/${"unbroken".repeat(40)}`,
};

test("message cards are collapsed by default and wrap unbroken content", () => {
  const html = renderMessageCard({ message: groupMessages([message])[0]!, analysis: null, pending: false });

  assert.match(html, /<details>/);
  assert.doesNotMatch(html, /<details\s+open/);
  assert.match(html, /<summary>[\s\S]*A very long message[\s\S]*<\/summary>/);
  assert.match(html, /<div class="message-body">[\s\S]*unbroken[\s\S]*<\/div>/);
  assert.match(MESSAGE_CARD_CSS, /overflow-wrap:anywhere/);
  assert.doesNotMatch(html, /checkbox|Valitse analysoitavaksi/);
});

test("notice cards are labeled in the shared message timeline", () => {
  const html = renderMessageCard({
    message: groupMessages([{ ...message, sourceType: "notice" }])[0]!,
    analysis: null,
    pending: false,
  });

  assert.match(html, /<span class="pill">Tiedote<\/span>/);
});

test("merged message cards show every affected child once", () => {
  const grouped = groupMessages([
      message,
      { ...message, accountId: "konservatorio", studentNumber: "202", child: "Valtteri", messageId: 8 },
      { ...message, accountId: "konservatorio", studentNumber: "303", child: "Child", messageId: 9 },
    ]);
  const html = renderMessageCard({
    message: grouped[0]!,
    analysis: null,
    pending: false,
  });

  assert.equal((html.match(/>Child<\/span>/g) ?? []).length, 1);
  assert.equal((html.match(/>Valtteri<\/span>/g) ?? []).length, 1);
  assert.match(html, /&quot;account:school&quot;/);
  assert.match(html, /&quot;account:konservatorio&quot;/);
  assert.match(html, /&quot;child:Child&quot;/);
  assert.match(html, /&quot;child:Valtteri&quot;/);

  const filters = renderMessageFilters(grouped);
  assert.match(filters, />school<\/button>/);
  assert.match(filters, />konservatorio<\/button>/);
  assert.match(filters, />Child<\/button>/);
  assert.match(filters, />Valtteri<\/button>/);
  assert.equal((filters.match(/data-message-filter="account:konservatorio"/g) ?? []).length, 1);
  assert.equal((filters.match(/data-message-filter-kind="account"/g) ?? []).length, 2);
  assert.equal((filters.match(/data-message-filter-kind="child"/g) ?? []).length, 2);
  assert.equal((filters.match(/aria-pressed="false"/g) ?? []).length, 4);
});

test("message filters OR within categories, AND between categories, and default to all visible", () => {
  class Element {
    hidden = false;
    readonly listeners: (() => void)[] = [];
    constructor(readonly attributes: Record<string, string>) {}
    getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
    setAttribute(name: string, value: string): void { this.attributes[name] = value; }
    addEventListener(name: string, listener: () => void): void {
      if (name === "click") this.listeners.push(listener);
    }
    click(): void { this.listeners.forEach((listener) => listener()); }
  }
  const school = new Element({ "data-message-filter-kind": "account", "data-message-filter": "account:school", "aria-pressed": "false" });
  const conservatory = new Element({ "data-message-filter-kind": "account", "data-message-filter": "account:konservatorio", "aria-pressed": "false" });
  const einari = new Element({ "data-message-filter-kind": "child", "data-message-filter": "child:Einari", "aria-pressed": "false" });
  const valtteri = new Element({ "data-message-filter-kind": "child", "data-message-filter": "child:Valtteri", "aria-pressed": "false" });
  const schoolCard = new Element({ "data-message-filters": JSON.stringify(["account:school", "child:Valtteri"]) });
  const conservatoryEinariCard = new Element({ "data-message-filters": JSON.stringify(["account:konservatorio", "child:Einari"]) });
  const conservatoryValtteriCard = new Element({ "data-message-filters": JSON.stringify(["account:konservatorio", "child:Valtteri"]) });
  runInNewContext(MESSAGE_FILTER_CLIENT_SCRIPT, {
    document: {
      querySelectorAll: (selector: string) => selector === "[data-message-filter]"
        ? [school, conservatory, einari, valtteri]
        : [schoolCard, conservatoryEinariCard, conservatoryValtteriCard],
    },
  });

  assert.equal(schoolCard.hidden, false);
  assert.equal(conservatoryEinariCard.hidden, false);
  assert.equal(conservatoryValtteriCard.hidden, false);
  school.click();
  assert.equal(schoolCard.hidden, false);
  assert.equal(conservatoryEinariCard.hidden, true);
  assert.equal(conservatoryValtteriCard.hidden, true);
  conservatory.click();
  assert.equal(schoolCard.hidden, false, "accounts are ORed within their category");
  assert.equal(conservatoryEinariCard.hidden, false);
  assert.equal(conservatoryValtteriCard.hidden, false);
  einari.click();
  assert.equal(schoolCard.hidden, true, "an account match must also match the selected child category");
  assert.equal(conservatoryEinariCard.hidden, false);
  assert.equal(conservatoryValtteriCard.hidden, true);
  valtteri.click();
  assert.equal(schoolCard.hidden, false, "children are ORed within their category");
  assert.equal(conservatoryEinariCard.hidden, false);
  assert.equal(conservatoryValtteriCard.hidden, false);
  school.click();
  assert.equal(schoolCard.hidden, true);
  assert.equal(conservatoryEinariCard.hidden, false);
  assert.equal(conservatoryValtteriCard.hidden, false);
  einari.click();
  valtteri.click();
  conservatory.click();
  assert.equal(schoolCard.hidden, false, "clearing all pills restores every card");
  assert.equal(conservatoryEinariCard.hidden, false);
  assert.equal(conservatoryValtteriCard.hidden, false);
  assert.match(MESSAGE_CARD_CSS, /\.card\[hidden\]\{display:none\}/);
});

test("every calendar line is a checkbox naming the source id sync writes", () => {
  const message = {
    logicalMessageId: "abc",
    subject: "Retkipäivä",
    sender: "Opettaja",
    content: "Retki on tiistaina.",
    sourceType: "message" as const,
    children: ["Valtteri"],
    members: [{ accountId: "school", studentNumber: "101", child: "Valtteri", messageId: 5 }],
    displaySentAt: new Date("2026-09-15T09:00:00Z"),
  } as unknown as Parameters<typeof renderMessageCard>[0]["message"];

  const html = renderMessageCard({
    message,
    analysis: {
      calendarItems: [
        { date: "2026-09-22", time: "09:00", title: "Retki", endDate: null, description: null },
        { date: "2026-09-23", time: null, title: "Väärä arvaus", endDate: null, description: null },
      ],
      hasOtherContent: false,
    } as unknown as Parameters<typeof renderMessageCard>[0]["analysis"],
    pending: false,
    droppedSourceIds: new Set(["wilma-message-group:abc:1"]),
  });

  assert.match(html, /name="sourceId" value="wilma-message-group:abc:0"/);
  assert.match(html, /name="sourceId" value="wilma-message-group:abc:1"/);
  // The kept item is checked; the dropped one is not, and reads as struck through.
  assert.equal(html.match(/checked/g)?.length, 1);
  assert.match(html, /class="muted dropped"/);
  assert.match(html, /name="returnTo" value="\/messages"/);
});

test("calendar items stay visible without expanding the message", () => {
  const message = {
    logicalMessageId: "visible",
    subject: "Retkipäivä",
    sender: "Opettaja",
    content: "Retki on tiistaina.",
    sourceType: "message" as const,
    children: ["Valtteri"],
    members: [{ accountId: "school", studentNumber: "101", child: "Valtteri", messageId: 5 }],
    displaySentAt: new Date("2026-09-15T09:00:00Z"),
  } as unknown as Parameters<typeof renderMessageCard>[0]["message"];

  const html = renderMessageCard({
    message,
    analysis: {
      calendarItems: [{ date: "2026-09-22", time: "09:00", title: "Retki", endDate: null, description: null }],
      hasOtherContent: false,
    } as unknown as Parameters<typeof renderMessageCard>[0]["analysis"],
    pending: false,
  });

  // The message body is what collapses; the checkbox must not be inside it.
  assert.ok(html.indexOf("</details>") < html.indexOf("Kalenteriin:"));
  assert.ok(html.indexOf("Retki on tiistaina.") < html.indexOf("</details>"));
});
