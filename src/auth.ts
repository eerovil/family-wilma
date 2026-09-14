import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SESSION_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;
const SESSION_COOKIE = "family_wilma_session";
const OAUTH_STATE_COOKIE = "family_wilma_oauth_state";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeReturnTo(value: string | null): string {
  return value?.startsWith("/") && !value.startsWith("//") && !value.includes("\\") && !/[\r\n]/.test(value)
    ? value
    : "/";
}

export class SessionStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "family-wilma.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS oauth_states (
        state_hash TEXT PRIMARY KEY,
        return_to TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_sessions (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
    `);
  }

  createOAuthState(returnTo: string | null): string {
    const state = randomBytes(32).toString("base64url");
    const now = this.now();
    this.db.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").run(now);
    this.db.prepare("INSERT INTO oauth_states (state_hash, return_to, expires_at) VALUES (?, ?, ?)")
      .run(hash(state), safeReturnTo(returnTo), now + OAUTH_STATE_MAX_AGE_SECONDS);
    return state;
  }

  consumeOAuthState(state: string): string | null {
    if (!state) return null;
    const row = this.db.prepare(
      "DELETE FROM oauth_states WHERE state_hash = ? AND expires_at > ? RETURNING return_to",
    ).get(hash(state), this.now()) as { return_to: string } | undefined;
    return row?.return_to ?? null;
  }

  createSession(): string {
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    this.db.prepare("DELETE FROM user_sessions WHERE expires_at <= ?").run(now);
    this.db.prepare(`
      INSERT INTO user_sessions (token_hash, expires_at, created_at, last_seen_at)
      VALUES (?, ?, ?, ?)
    `).run(hash(token), now + SESSION_MAX_AGE_SECONDS, now, now);
    return token;
  }

  authenticate(token: string | null): boolean {
    if (!token) return false;
    const now = this.now();
    const tokenHash = hash(token);
    const row = this.db.prepare(
      "SELECT 1 AS present FROM user_sessions WHERE token_hash = ? AND expires_at > ?",
    ).get(tokenHash, now) as { present: number } | undefined;
    if (!row) {
      this.db.prepare("DELETE FROM user_sessions WHERE token_hash = ?").run(tokenHash);
      return false;
    }
    this.db.prepare("UPDATE user_sessions SET expires_at = ?, last_seen_at = ? WHERE token_hash = ?")
      .run(now + SESSION_MAX_AGE_SECONDS, now, tokenHash);
    return true;
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
  return `${cookieName(SESSION_COOKIE, secure)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${cookieName(SESSION_COOKIE, secure)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function oauthStateCookie(state: string, secure: boolean): string {
  return `${cookieName(OAUTH_STATE_COOKIE, secure)}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${OAUTH_STATE_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`;
}

export function clearOAuthStateCookie(secure: boolean): string {
  return `${cookieName(OAUTH_STATE_COOKIE, secure)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}
