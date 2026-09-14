import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface CalendarItem {
  title: string;
  date: string;
  time: string | null;
  endDate: string | null;
  description: string | null;
}

export interface MessageAnalysis {
  calendarItems: CalendarItem[];
  hasOtherContent: boolean;
}

export interface AnalysisIdentity {
  accountId: string;
  studentNumber: string;
  messageId: number;
  content: string;
  analyzerVersion: string;
}

export class AnalysisStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "family-wilma.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS message_analysis (
        cache_key TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        student_number TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        analyzer_version TEXT NOT NULL,
        analysis_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  key(identity: AnalysisIdentity): { key: string; contentHash: string } {
    const contentHash = createHash("sha256").update(identity.content).digest("hex");
    const key = createHash("sha256")
      .update([identity.accountId, identity.studentNumber, String(identity.messageId), contentHash, identity.analyzerVersion].join("\0"))
      .digest("hex");
    return { key, contentHash };
  }

  get(identity: AnalysisIdentity): MessageAnalysis | null {
    const { key } = this.key(identity);
    const row = this.db.prepare("SELECT analysis_json FROM message_analysis WHERE cache_key = ?").get(key) as
      | { analysis_json: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.analysis_json) as MessageAnalysis;
    } catch {
      return null;
    }
  }

  put(identity: AnalysisIdentity, analysis: MessageAnalysis): void {
    const { key, contentHash } = this.key(identity);
    this.db.prepare(`
      INSERT OR REPLACE INTO message_analysis
        (cache_key, account_id, student_number, message_id, content_hash, analyzer_version, analysis_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      key,
      identity.accountId,
      identity.studentNumber,
      identity.messageId,
      contentHash,
      identity.analyzerVersion,
      JSON.stringify(analysis),
      new Date().toISOString(),
    );
  }
}
