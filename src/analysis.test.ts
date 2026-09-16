import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { analysisIdentity, MessageAnalyzer } from "./analysis.js";
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
