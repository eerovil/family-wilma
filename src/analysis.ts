import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { AnalysisStore, type CalendarItem, type MessageAnalysis } from "./store.js";

export const ANALYZER_VERSION = "family-wilma-v1-2026-09-14";
export const SONNET_MODEL = "claude-sonnet-4-5-20250929";

const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    calendarItems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          time: { anyOf: [{ type: "string" }, { type: "null" }] },
          endDate: {
            anyOf: [
              { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
              { type: "null" },
            ],
          },
          description: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        required: ["title", "date", "time", "endDate", "description"],
        additionalProperties: false,
      },
    },
    hasOtherContent: { type: "boolean" },
  },
  required: ["calendarItems", "hasOtherContent"],
  additionalProperties: false,
} as const;

const ANALYSIS_OUTPUT_FORMAT = jsonSchemaOutputFormat(ANALYSIS_SCHEMA);

export const ANALYSIS_INSTRUCTIONS = [
  "You extract calendar-worthy facts from Finnish school/daycare Wilma messages for a parent.",
  "Return JSON matching: {\"calendarItems\":[{\"title\":string,\"date\":\"YYYY-MM-DD\",\"time\":string|null,\"endDate\":\"YYYY-MM-DD\"|null,\"description\":string|null}],\"hasOtherContent\":boolean}.",
  "hasOtherContent is true whenever meaningful information would be lost if the parent saw only the calendar items. When uncertain, use true.",
  "Do not invent dates. Resolve relative dates using the message sent date where possible; otherwise omit that calendar item.",
];

export interface AnalyzableMessage {
  accountId: string;
  studentNumber: string;
  child: string;
  messageId: number;
  subject: string;
  sender: string;
  sentAt: Date;
  content: string;
  analysisAliases?: AnalyzableMessage[];
  logicalMessageId?: string;
  logicalSentDate?: string;
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseAnalysis(value: unknown): MessageAnalysis {
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

export function analysisIdentity(message: AnalyzableMessage) {
  if (message.logicalMessageId && message.logicalSentDate) {
    return {
      accountId: "logical-message",
      studentNumber: message.logicalMessageId,
      messageId: 0,
      content: [message.logicalSentDate, message.subject, message.sender, message.content].join("\n\n"),
      analyzerVersion: ANALYZER_VERSION,
    };
  }
  return {
    accountId: message.accountId,
    studentNumber: message.studentNumber,
    messageId: message.messageId,
    content: [message.subject, message.sender, message.sentAt.toISOString(), message.content].join("\n\n"),
    analyzerVersion: ANALYZER_VERSION,
  };
}

export function analysisIdentities(message: AnalyzableMessage) {
  return [message, ...(message.analysisAliases ?? [])].map(analysisIdentity);
}

function prompt(message: AnalyzableMessage) {
  return {
    model: SONNET_MODEL,
    max_tokens: 1200,
    system: ANALYSIS_INSTRUCTIONS.join("\n"),
    messages: [{
      role: "user" as const,
      content: [
        `Child: ${message.child}`,
        `Sent: ${message.sentAt.toISOString()}`,
        `Subject: ${message.subject}`,
        `Sender: ${message.sender}`,
        "Message:",
        message.content,
      ].join("\n"),
    }],
  };
}

export function batchAnalysisRequest(message: AnalyzableMessage): Anthropic.MessageCreateParamsNonStreaming {
  return {
    ...prompt(message),
    output_config: {
      format: { type: "json_schema", schema: ANALYSIS_SCHEMA },
    },
  };
}

export class MessageAnalyzer {
  private readonly anthropic: Anthropic | null;

  constructor(apiKey: string | null, private readonly store: AnalysisStore, anthropic?: Anthropic) {
    this.anthropic = anthropic ?? (apiKey ? new Anthropic({ apiKey }) : null);
  }

  cached(message: AnalyzableMessage): MessageAnalysis | null {
    const identities = analysisIdentities(message);
    for (const [index, identity] of identities.entries()) {
      const cached = this.store.get(identity);
      if (cached) {
        if (index > 0) this.store.put(identities[0]!, cached);
        return cached;
      }
    }
    return null;
  }

  async analyze(message: AnalyzableMessage): Promise<{ analysis: MessageAnalysis; cached: boolean }> {
    const cacheIdentity = analysisIdentity(message);
    const cached = this.cached(message);
    if (cached) return { analysis: cached, cached: true };

    if (!this.anthropic) throw new Error("Anthropic analysis is disabled");
    const response = await this.anthropic.messages.parse({
      ...prompt(message),
      output_config: { format: ANALYSIS_OUTPUT_FORMAT },
    });
    const analysis = parseAnalysis(response.parsed_output);
    this.store.put(cacheIdentity, analysis);
    return { analysis, cached: false };
  }
}
