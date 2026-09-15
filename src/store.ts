import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
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

export interface AnalysisBatchStatus {
  batchId: string;
  status: string;
  total: number;
  succeeded: number;
  failed: number;
  imported: number;
}

export interface PendingAnalysisBatch {
  batchId: string;
  providerBatchId: string;
}

export class AnalysisStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    const databasePath = join(dataDir, "family-wilma.sqlite");
    this.db = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
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
      CREATE TABLE IF NOT EXISTS analysis_batches (
        batch_id TEXT PRIMARY KEY,
        provider_batch_id TEXT,
        status TEXT NOT NULL,
        total INTEGER NOT NULL,
        succeeded INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS analysis_batch_items (
        batch_id TEXT NOT NULL,
        custom_id TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        account_id TEXT NOT NULL,
        student_number TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        analyzer_version TEXT NOT NULL,
        imported INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (batch_id, custom_id),
        FOREIGN KEY (batch_id) REFERENCES analysis_batches(batch_id)
      );
      CREATE INDEX IF NOT EXISTS analysis_batch_items_cache_key ON analysis_batch_items(cache_key);
    `);
    const batchColumns = this.db.prepare("PRAGMA table_info(analysis_batches)").all() as unknown as Array<{ name: string }>;
    if (!batchColumns.some((column) => column.name === "provider_batch_id")) {
      this.db.exec("ALTER TABLE analysis_batches ADD COLUMN provider_batch_id TEXT");
      this.db.exec("UPDATE analysis_batches SET provider_batch_id = batch_id");
    }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS analysis_batches_provider_id ON analysis_batches(provider_batch_id)");
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

  reserveBatch(batchId: string, items: Array<{ customId: string; identity: AnalysisIdentity }>): void {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO analysis_batches (batch_id, status, total, created_at, updated_at)
        VALUES (?, 'submitting', ?, ?, ?)
      `).run(batchId, items.length, now, now);
      const insert = this.db.prepare(`
        INSERT INTO analysis_batch_items
          (batch_id, custom_id, cache_key, account_id, student_number, message_id, content_hash, analyzer_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        const { key, contentHash } = this.key(item.identity);
        insert.run(batchId, item.customId, key, item.identity.accountId, item.identity.studentNumber,
          item.identity.messageId, contentHash, item.identity.analyzerVersion);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  attachProviderBatch(batchId: string, providerBatchId: string): void {
    this.db.prepare(`
      UPDATE analysis_batches
      SET provider_batch_id = ?, status = 'in_progress', updated_at = ?
      WHERE batch_id = ? AND status = 'submitting'
    `).run(providerBatchId, new Date().toISOString(), batchId);
  }

  hasPending(identity: AnalysisIdentity): boolean {
    const { key } = this.key(identity);
    const row = this.db.prepare(`
      SELECT 1 AS present
      FROM analysis_batch_items i
      JOIN analysis_batches b ON b.batch_id = i.batch_id
      WHERE i.cache_key = ? AND b.status IN ('submitting', 'in_progress')
      LIMIT 1
    `).get(key) as { present: number } | undefined;
    return Boolean(row);
  }

  pendingBatches(): PendingAnalysisBatch[] {
    const rows = this.db.prepare(
      "SELECT batch_id, provider_batch_id FROM analysis_batches WHERE status = 'in_progress' ORDER BY created_at",
    ).all() as unknown as Array<{ batch_id: string; provider_batch_id: string }>;
    return rows.map((row) => ({ batchId: row.batch_id, providerBatchId: row.provider_batch_id }));
  }

  updateBatch(batchId: string, counts: { succeeded: number; failed: number }): void {
    this.db.prepare(`
      UPDATE analysis_batches SET succeeded = ?, failed = ?, updated_at = ? WHERE batch_id = ?
    `).run(counts.succeeded, counts.failed, new Date().toISOString(), batchId);
  }

  putBatchResult(batchId: string, customId: string, analysis: MessageAnalysis): void {
    const item = this.db.prepare(`
      SELECT cache_key, account_id, student_number, message_id, content_hash, analyzer_version
      FROM analysis_batch_items WHERE batch_id = ? AND custom_id = ?
    `).get(batchId, customId) as {
      cache_key: string;
      account_id: string;
      student_number: string;
      message_id: number;
      content_hash: string;
      analyzer_version: string;
    } | undefined;
    if (!item) throw new Error("Unknown analysis batch item");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO message_analysis
          (cache_key, account_id, student_number, message_id, content_hash, analyzer_version, analysis_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(item.cache_key, item.account_id, item.student_number, item.message_id, item.content_hash,
        item.analyzer_version, JSON.stringify(analysis), new Date().toISOString());
      this.db.prepare("UPDATE analysis_batch_items SET imported = 1 WHERE batch_id = ? AND custom_id = ?")
        .run(batchId, customId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  finishBatch(batchId: string, counts: { succeeded: number; failed: number }): void {
    this.db.prepare(`
      UPDATE analysis_batches SET status = 'ended', succeeded = ?, failed = ?, updated_at = ? WHERE batch_id = ?
    `).run(counts.succeeded, counts.failed, new Date().toISOString(), batchId);
  }

  batchStatuses(): AnalysisBatchStatus[] {
    const rows = this.db.prepare(`
      SELECT b.batch_id AS batchId, b.status, b.total, b.succeeded, b.failed,
             COALESCE(SUM(i.imported), 0) AS imported
      FROM analysis_batches b
      LEFT JOIN analysis_batch_items i ON i.batch_id = b.batch_id
      GROUP BY b.batch_id
      ORDER BY b.created_at DESC
      LIMIT 10
    `).all() as unknown as AnalysisBatchStatus[];
    return rows.map((row) => ({ ...row }));
  }
}
