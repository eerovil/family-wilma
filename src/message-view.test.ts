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
  assert.equal((filters.match(/aria-pressed="false"/g) ?? []).length, 4);
});

test("message filter client applies one global OR and defaults to all visible", () => {
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
  const school = new Element({ "data-message-filter": "account:school", "aria-pressed": "false" });
  const einari = new Element({ "data-message-filter": "child:Einari", "aria-pressed": "false" });
  const schoolCard = new Element({ "data-message-filters": JSON.stringify(["account:school", "child:Valtteri"]) });
  const mergedCard = new Element({ "data-message-filters": JSON.stringify(["account:konservatorio", "child:Einari", "child:Valtteri"]) });
  runInNewContext(MESSAGE_FILTER_CLIENT_SCRIPT, {
    document: {
      querySelectorAll: (selector: string) => selector === "[data-message-filter]"
        ? [school, einari]
        : [schoolCard, mergedCard],
    },
  });

  assert.equal(schoolCard.hidden, false);
  assert.equal(mergedCard.hidden, false);
  school.click();
  assert.equal(schoolCard.hidden, false);
  assert.equal(mergedCard.hidden, true);
  einari.click();
  assert.equal(schoolCard.hidden, false);
  assert.equal(mergedCard.hidden, false, "a child match is ORed with an account match");
  school.click();
  assert.equal(schoolCard.hidden, true);
  assert.equal(mergedCard.hidden, false);
  einari.click();
  assert.equal(schoolCard.hidden, false, "clearing all pills restores every card");
  assert.equal(mergedCard.hidden, false);
  assert.match(MESSAGE_CARD_CSS, /\.card\[hidden\]\{display:none\}/);
});
