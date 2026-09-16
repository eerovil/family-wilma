import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FetchedMessage, SourceCalendarItem, WilmaBundle } from "./wilma.js";

export interface CachedMessages {
  messages: FetchedMessage[];
  structuredCalendarItems: SourceCalendarItem[];
  updatedAt: string;
}

interface StoredMessage extends Omit<FetchedMessage, "sentAt"> {
  sentAt: string;
}

interface StoredPayload {
  version: 1;
  messages: StoredMessage[];
  structuredCalendarItems: SourceCalendarItem[];
}

export class MessageCacheStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string, private readonly identity: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    const databasePath = join(dataDir, "family-wilma.sqlite");
    this.db = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS message_cache (
        cache_name TEXT PRIMARY KEY,
        identity_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  get(): CachedMessages | null {
    const row = this.db.prepare(`
      SELECT payload_json, updated_at FROM message_cache
      WHERE cache_name = 'recent' AND identity_hash = ?
    `).get(this.identity) as { payload_json: string; updated_at: string } | undefined;
    if (!row || !validTimestamp(row.updated_at)) return null;
    try {
      const value: unknown = JSON.parse(row.payload_json);
      if (!isStoredPayload(value)) return null;
      return {
        messages: value.messages.map((message) => ({ ...message, sentAt: new Date(message.sentAt) })),
        structuredCalendarItems: value.structuredCalendarItems,
        updatedAt: row.updated_at,
      };
    } catch {
      return null;
    }
  }

  put(bundle: Pick<WilmaBundle, "messages" | "structuredCalendarItems">, updatedAt: string): void {
    const payload: StoredPayload = {
      version: 1,
      messages: bundle.messages.map((message) => ({ ...message, sentAt: message.sentAt.toISOString() })),
      structuredCalendarItems: bundle.structuredCalendarItems,
    };
    this.db.prepare(`
      INSERT INTO message_cache (cache_name, identity_hash, payload_json, updated_at)
      VALUES ('recent', ?, ?, ?)
      ON CONFLICT(cache_name) DO UPDATE SET
        identity_hash = excluded.identity_hash,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(this.identity, JSON.stringify(payload), updatedAt);
  }
}

function isStoredPayload(value: unknown): value is StoredPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<StoredPayload>;
  return payload.version === 1
    && Array.isArray(payload.messages)
    && payload.messages.every(isStoredMessage)
    && Array.isArray(payload.structuredCalendarItems)
    && payload.structuredCalendarItems.every(isCalendarItem);
}

function isStoredMessage(value: unknown): value is StoredMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return ["accountId", "studentNumber", "child", "subject", "sender", "content"].every((key) => typeof message[key] === "string")
    && (message.sourceType === undefined || message.sourceType === "message" || message.sourceType === "notice")
    && typeof message.messageId === "number"
    && Number.isInteger(message.messageId)
    && typeof message.sentAt === "string"
    && validTimestamp(message.sentAt);
}

function isCalendarItem(value: unknown): value is SourceCalendarItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return ["sourceId", "title", "date"].every((key) => typeof item[key] === "string")
    && (item.time === null || typeof item.time === "string")
    && (item.endTime === undefined || item.endTime === null || typeof item.endTime === "string")
    && (item.endDate === null || typeof item.endDate === "string")
    && (item.description === null || typeof item.description === "string");
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(new Date(value).getTime());
}
