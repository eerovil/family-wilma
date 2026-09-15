import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PedanetHomework } from "./pedanet-homework.js";
import type { WilmaAccountConfig } from "./config.js";
import type { FetchedHomework } from "./wilma.js";

export interface CachedValue<T> {
  value: T;
  updatedAt: string;
}

type HomeworkSource = "wilma" | "pedanet";

export function homeworkCacheIdentity(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function wilmaHomeworkCacheIdentity(accounts: WilmaAccountConfig[]): string {
  return homeworkCacheIdentity(accounts.map((account) => ({
    id: account.id,
    baseUrl: account.baseUrl,
    username: account.username,
    profiles: account.profiles,
  })));
}

export class HomeworkCacheStore {
  private readonly db: DatabaseSync;

  constructor(
    dataDir: string,
    private readonly identities: { wilma: string; pedanet: string | null },
  ) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    const databasePath = join(dataDir, "family-wilma.sqlite");
    this.db = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS homework_cache (
        source TEXT PRIMARY KEY,
        identity_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  getWilma(): CachedValue<FetchedHomework[]> | null {
    return this.get("wilma", isFetchedHomeworkArray);
  }

  putWilma(value: FetchedHomework[], updatedAt: string): void {
    this.put("wilma", value, updatedAt);
  }

  getPedanet(): CachedValue<PedanetHomework> | null {
    if (!this.identities.pedanet) return null;
    return this.get("pedanet", isPedanetHomework);
  }

  putPedanet(value: PedanetHomework, updatedAt: string): void {
    if (!this.identities.pedanet) return;
    this.put("pedanet", value, updatedAt);
  }

  private get<T>(source: HomeworkSource, validate: (value: unknown) => value is T): CachedValue<T> | null {
    const identity = this.identities[source];
    if (!identity) return null;
    const row = this.db.prepare(`
      SELECT payload_json, updated_at FROM homework_cache
      WHERE source = ? AND identity_hash = ?
    `).get(source, identity) as { payload_json: string; updated_at: string } | undefined;
    if (!row) return null;
    try {
      const value: unknown = JSON.parse(row.payload_json);
      return validate(value) ? { value, updatedAt: row.updated_at } : null;
    } catch {
      return null;
    }
  }

  private put(source: HomeworkSource, value: unknown, updatedAt: string): void {
    const identity = this.identities[source];
    if (!identity) return;
    this.db.prepare(`
      INSERT INTO homework_cache (source, identity_hash, payload_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET
        identity_hash = excluded.identity_hash,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(source, identity, JSON.stringify(value), updatedAt);
  }
}

function isFetchedHomeworkArray(value: unknown): value is FetchedHomework[] {
  return Array.isArray(value) && value.every((item) => isRecordWithStrings(item, [
    "accountId", "studentNumber", "child", "date", "subject", "subjectCode",
    "homework", "teacher", "teacherCode",
  ]));
}

function isPedanetHomework(value: unknown): value is PedanetHomework {
  return isRecordWithStrings(value, ["date", "heading", "content", "sourceUrl"])
    && value.personalizationStatus === "unresolved";
}

function isRecordWithStrings(value: unknown, fields: string[]): value is Record<string, string> {
  return Boolean(value && typeof value === "object"
    && fields.every((field) => typeof (value as Record<string, unknown>)[field] === "string"));
}
