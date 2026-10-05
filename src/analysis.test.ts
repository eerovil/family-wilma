import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { analysisIdentity, MessageAnalyzer, normaliseTime } from "./analysis.js";
import { AnalysisStore } from "./store.js";

test("message analysis requests and consumes schema-constrained JSON", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "family-wilma-analysis-"));
  let requestedFormat: unknown;
  const anthropic = {
    messages: {
      parse: async (params: { output_config?: { format?: unknown } }) => {
        requestedFormat = params.output_config?.format;
        return {
          parsed_output: {
            calendarItems: [{
              title: "Parent evening",
              date: "2026-09-20",
              time: null,
              endDate: null,
              description: null,
            }],
            hasOtherContent: true,
          },
        };
      },
    },
  } as unknown as Anthropic;

  try {
    const analyzer = new MessageAnalyzer("test", new AnalysisStore(dataDir), anthropic);
    const result = await analyzer.analyze({
      accountId: "school",
      studentNumber: "101",
      child: "Child",
      messageId: 1,
      subject: "Subject",
      sender: "Teacher",
      sentAt: new Date("2026-09-15T08:00:00Z"),
      content: "Content",
    });

    assert.deepEqual(result.analysis, {
      calendarItems: [{
        title: "Parent evening",
        date: "2026-09-20",
        time: null,
        endDate: null,
        description: null,
      }],
      hasOtherContent: true,
    });
    assert.equal((requestedFormat as { type?: string })?.type, "json_schema");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("notice and inbox message ids use separate analysis identities", () => {
  const message = {
    accountId: "school",
    studentNumber: "101",
    child: "Child",
    messageId: 7,
    subject: "Same subject",
    sender: "Teacher",
    sentAt: new Date("2026-09-15T08:00:00Z"),
    content: "Same content",
  };

  assert.notDeepEqual(
    analysisIdentity(message),
    analysisIdentity({ ...message, sourceType: "notice" }),
  );
});

test("free-text times become HH:MM or an all-day item", () => {
  assert.deepEqual(normaliseTime("18:00"), { time: "18:00", endTime: null });
  assert.deepEqual(normaliseTime("18.00"), { time: "18:00", endTime: null });
  assert.deepEqual(normaliseTime("8:30"), { time: "08:30", endTime: null });
  assert.deepEqual(normaliseTime("klo 18"), { time: "18:00", endTime: null });
  assert.deepEqual(normaliseTime("Kello 9.15"), { time: "09:15", endTime: null });
  assert.deepEqual(normaliseTime("16:45-17:30"), { time: "16:45", endTime: "17:30" });
  assert.deepEqual(normaliseTime("8:30–12:30"), { time: "08:30", endTime: "12:30" });
  assert.deepEqual(normaliseTime("12:00-24:00"), { time: "12:00", endTime: null });
  assert.equal(normaliseTime("aamupäivällä"), null);
  assert.equal(normaliseTime("Kaksi viimeistä tuntia"), null);
  assert.equal(normaliseTime("25:00"), null);
  assert.equal(normaliseTime(null), null);
});

