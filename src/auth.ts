import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SESSION_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;
const SESSION_COOKIE = "family_wilma_session";
const OAUTH_STATE_COOKIE = "family_wilma_oauth_state";

export type OAuthPurpose = "login" | "calendar";
export interface OAuthState { returnTo: string; purpose: OAuthPurpose }

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeReturnPath(value: string | null): string {
  return value?.startsWith("/") && !value.startsWith("//") && !value.includes("\\") && !/[\r\n]/.test(value)
    ? value
    : "/";
}

export class SessionStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    const databasePath = join(dataDir, "family-wilma.sqlite");
    this.db = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS oauth_states (
        state_hash TEXT PRIMARY KEY,
        return_to TEXT NOT NULL,
        purpose TEXT NOT NULL DEFAULT 'invalid',
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_sessions (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
    `);
    this.addColumnIfMissing("oauth_states", "purpose", "TEXT NOT NULL DEFAULT 'invalid'");
    this.addColumnIfMissing("user_sessions", "email", "TEXT");
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  createOAuthState(returnTo: string | null, purpose: OAuthPurpose = "login"): string {
    const state = randomBytes(32).toString("base64url");
    const now = this.now();
    this.db.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").run(now);
    this.db.prepare("INSERT INTO oauth_states (state_hash, return_to, purpose, expires_at) VALUES (?, ?, ?, ?)")
      .run(hash(state), safeReturnPath(returnTo), purpose, now + OAUTH_STATE_MAX_AGE_SECONDS);
    return state;
  }

  consumeOAuthState(state: string): OAuthState | null {
    if (!state) return null;
    const row = this.db.prepare(
      "DELETE FROM oauth_states WHERE state_hash = ? AND expires_at > ? RETURNING return_to, purpose",
    ).get(hash(state), this.now()) as { return_to: string; purpose: string } | undefined;
    if (!row || (row.purpose !== "login" && row.purpose !== "calendar")) return null;
    return { returnTo: row.return_to, purpose: row.purpose };
  }

  createSession(email: string): string {
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    this.db.prepare("DELETE FROM user_sessions WHERE expires_at <= ?").run(now);
    this.db.prepare(`
      INSERT INTO user_sessions (token_hash, expires_at, created_at, last_seen_at, email)
      VALUES (?, ?, ?, ?, ?)
    `).run(hash(token), now + SESSION_MAX_AGE_SECONDS, now, now, email.trim().toLowerCase());
    return token;
  }

  authenticate(token: string | null): boolean {
    if (!token) return false;
    const now = this.now();
    const tokenHash = hash(token);
    const row = this.db.prepare(
      "SELECT email FROM user_sessions WHERE token_hash = ? AND expires_at > ?",
    ).get(tokenHash, now) as { email: string | null } | undefined;
    if (!row?.email) {
      this.db.prepare("DELETE FROM user_sessions WHERE token_hash = ?").run(tokenHash);
      return false;
    }
    this.db.prepare("UPDATE user_sessions SET expires_at = ?, last_seen_at = ? WHERE token_hash = ?")
      .run(now + SESSION_MAX_AGE_SECONDS, now, tokenHash);
    return true;
  }

  sessionEmail(token: string | null): string | null {
    if (!token) return null;
    const row = this.db.prepare(
      "SELECT email FROM user_sessions WHERE token_hash = ? AND expires_at > ?",
    ).get(hash(token), this.now()) as { email: string | null } | undefined;
    return row?.email ?? null;
  }

  destroySession(token: string | null): void {
    if (token) this.db.prepare("DELETE FROM user_sessions WHERE token_hash = ?").run(hash(token));
  }
}

function cookieToken(cookieHeader: string | undefined, names: string[]): string | null {
  const cookies = new Map<string, string>();
  for (const part of cookieHeader?.split(";") ?? []) {
    const [name, ...value] = part.trim().split("=");
    if (name) cookies.set(name, value.join("="));
  }
  for (const name of names) {
    const value = cookies.get(name);
    if (value) return value;
  }
  return null;
}

export function sessionToken(cookieHeader: string | undefined, secure: boolean): string | null {
  return cookieToken(cookieHeader, [secure ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE]);
}

export function oauthStateToken(cookieHeader: string | undefined, secure: boolean): string | null {
  return cookieToken(cookieHeader, [secure ? `__Host-${OAUTH_STATE_COOKIE}` : OAUTH_STATE_COOKIE]);
}

function cookieName(name: string, secure: boolean): string {
  return secure ? `__Host-${name}` : name;
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${cookieName(SESSION_COOKIE, secure)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${cookieName(SESSION_COOKIE, secure)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function oauthStateCookie(state: string, secure: boolean): string {
  return `${cookieName(OAUTH_STATE_COOKIE, secure)}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${OAUTH_STATE_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`;
}

export function clearOAuthStateCookie(secure: boolean): string {
  return `${cookieName(OAUTH_STATE_COOKIE, secure)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}
