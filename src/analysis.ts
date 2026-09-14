import Anthropic from "@anthropic-ai/sdk";
import { AnalysisStore, type CalendarItem, type MessageAnalysis } from "./store.js";

export const ANALYZER_VERSION = "family-wilma-v1-2026-09-14";
export const SONNET_MODEL = "claude-sonnet-4-5-20250929";

export interface AnalyzableMessage {
  accountId: string;
  studentNumber: string;
  child: string;
  messageId: number;
  subject: string;
  sender: string;
  sentAt: Date;
  content: string;
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseAnalysis(raw: string): MessageAnalysis {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("analysis was not an object");
  const object = value as Record<string, unknown>;
  if (!Array.isArray(object.calendarItems)) throw new Error("analysis calendarItems was not an array");
  const calendarItems: CalendarItem[] = object.calendarItems.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("calendar item was not an object");
    const item = entry as Record<string, unknown>;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (!title || !isDate(item.date)) throw new Error("calendar item needs title and YYYY-MM-DD date");
    return {
      title,
      date: item.date,
      time: nullableString(item.time),
      endDate: isDate(item.endDate) ? item.endDate : null,
      description: nullableString(item.description),
    };
  });
  return {
    calendarItems,
    hasOtherContent: object.hasOtherContent !== false,
  };
}

export class MessageAnalyzer {
  private readonly anthropic: Anthropic;

  constructor(apiKey: string, private readonly store: AnalysisStore) {
    this.anthropic = new Anthropic({ apiKey });
  }

  async analyze(message: AnalyzableMessage): Promise<{ analysis: MessageAnalysis; cached: boolean }> {
    const cacheIdentity = {
      accountId: message.accountId,
      studentNumber: message.studentNumber,
      messageId: message.messageId,
      content: [message.subject, message.sender, message.sentAt.toISOString(), message.content].join("\n\n"),
      analyzerVersion: ANALYZER_VERSION,
    };
    const cached = this.store.get(cacheIdentity);
    if (cached) return { analysis: cached, cached: true };

    const response = await this.anthropic.messages.create({
      model: SONNET_MODEL,
      max_tokens: 1200,
      system: [
        "You extract calendar-worthy facts from Finnish school/daycare Wilma messages for a parent.",
        "Return JSON only, no markdown.",
        "Schema: {\"calendarItems\":[{\"title\":string,\"date\":\"YYYY-MM-DD\",\"time\":string|null,\"endDate\":\"YYYY-MM-DD\"|null,\"description\":string|null}],\"hasOtherContent\":boolean}.",
        "hasOtherContent is true whenever the message contains meaningful information that would be lost if the parent saw only the calendar items. When uncertain, use true.",
        "Do not invent dates. Resolve relative dates using the message sent date where possible; otherwise omit that calendar item.",
      ].join("\n"),
      messages: [{
        role: "user",
        content: [
          `Child: ${message.child}`,
          `Sent: ${message.sentAt.toISOString()}`,
          `Subject: ${message.subject}`,
          `Sender: ${message.sender}`,
          "Message:",
          message.content,
        ].join("\n"),
      }],
    });
    const text = response.content.find((block) => block.type === "text");
    if (!text || text.type !== "text") throw new Error("Sonnet returned no text analysis");
    const analysis = parseAnalysis(text.text);
    this.store.put(cacheIdentity, analysis);
    return { analysis, cached: false };
  }
}
