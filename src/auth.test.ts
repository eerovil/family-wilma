import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearOAuthStateCookie, clearSessionCookie, oauthStateCookie, oauthStateToken, sessionCookie, sessionToken, SessionStore } from "./auth.js";

test("OAuth state is one-time, expiring, and keeps only safe return paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "family-wilma-auth-"));
  let now = 100;
  try {
    const store = new SessionStore(dir, () => now);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "family-wilma.sqlite")).mode & 0o777, 0o600);
    const state = store.createOAuthState("/setup");
    assert.equal(store.consumeOAuthState(state), "/setup");
    assert.equal(store.consumeOAuthState(state), null);

    const unsafe = store.createOAuthState("//attacker.example");
    assert.equal(store.consumeOAuthState(unsafe), "/");
    const backslash = store.createOAuthState("/\\attacker.example");
    assert.equal(store.consumeOAuthState(backslash), "/");

    const expired = store.createOAuthState("/");
    now += 601;
    assert.equal(store.consumeOAuthState(expired), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sessions are revocable and their one-year expiry slides on use", () => {
  const dir = mkdtempSync(join(tmpdir(), "family-wilma-auth-"));
  let now = 100;
  try {
    const store = new SessionStore(dir, () => now);
    const token = store.createSession();
    assert.equal(store.authenticate(token), true);
    now += 364 * 24 * 60 * 60;
    assert.equal(store.authenticate(token), true);
    now += 2 * 24 * 60 * 60;
    assert.equal(store.authenticate(token), true);
    store.destroySession(token);
    assert.equal(store.authenticate(token), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session cookie helpers use a secure HTTP-only same-site cookie", () => {
  const cookie = sessionCookie("secret-token", true);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /__Host-family_wilma_session=/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.equal(sessionToken(`other=x; ${cookie.split(";")[0]}`, true), "secret-token");
  assert.equal(sessionToken("family_wilma_session=attacker", true), null);
  assert.match(clearSessionCookie(true), /Max-Age=0/);
  const oauthCookie = oauthStateCookie("oauth-state", true);
  assert.match(oauthCookie, /__Host-family_wilma_oauth_state=/);
  assert.match(oauthCookie, /SameSite=Lax/);
  assert.equal(oauthStateToken(oauthCookie, true), "oauth-state");
  assert.equal(oauthStateToken("family_wilma_oauth_state=attacker", true), null);
  assert.match(clearOAuthStateCookie(true), /Max-Age=0/);
});
