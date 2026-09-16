import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { analysisIdentity } from "./analysis.js";
import { wilmaCacheIdentity } from "./homework-cache.js";
import { MessageCacheStore } from "./message-cache.js";
import { groupMessages } from "./message-group.js";
import { AnalysisStore } from "./store.js";

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") return reject(new Error("No test port"));
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

test("health stays public while application pages require Google sign-in", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "family-wilma-http-"));
  const port = await availablePort();
  const cachedMessage = {
    accountId: "school",
    studentNumber: "1",
    child: "Test child",
    messageId: 42,
    subject: "Cached message",
    sender: "Teacher",
    sentAt: new Date(),
    content: "Visible without waiting for Wilma.",
  };
  new MessageCacheStore(dataDir, wilmaCacheIdentity([])).put({
    messages: [cachedMessage],
    structuredCalendarItems: [],
  }, new Date().toISOString());
  const analysisStore = new AnalysisStore(dataDir);
  analysisStore.reserveBatch("stale-completed-batch", [{
    customId: "message_0",
    identity: analysisIdentity(groupMessages([cachedMessage])[0]!),
  }]);
  analysisStore.finishBatch("stale-completed-batch", { succeeded: 1, failed: 0 });
  analysisStore.reserveBatch("fresh-completed-batch", [{
    customId: "message_0",
    identity: analysisIdentity({ ...groupMessages([cachedMessage])[0]!, messageId: 43 }),
  }]);
  analysisStore.finishBatch("fresh-completed-batch", { succeeded: 1, failed: 0 });
  const staleDb = new DatabaseSync(join(dataDir, "family-wilma.sqlite"));
  staleDb.prepare("UPDATE analysis_batches SET updated_at = ? WHERE batch_id = ?")
    .run("2026-09-15T00:00:00.000Z", "stale-completed-batch");
  staleDb.close();
  const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "index.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      APP_BASE_URL: `http://127.0.0.1:${port}`,
      DATA_DIR: dataDir,
      ANTHROPIC_API_KEY: "test",
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
      GOOGLE_ALLOWED_EMAIL: "owner@example.com",
      GOOGLE_ALLOWED_LOGIN_EMAILS: "owner@example.com,member@example.com",
      WILMA_ACCOUNTS_JSON: "[]",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("server did not start")), 10_000);
      child.once("exit", (code) => reject(new Error(`server exited ${code}`)));
      child.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("listening")) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);

    const manifestResponse = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`);
    assert.equal(manifestResponse.status, 200);
    assert.match(manifestResponse.headers.get("content-type") ?? "", /application\/manifest\+json/);
    assert.equal(manifestResponse.headers.get("cache-control"), "no-cache");
    assert.equal((await manifestResponse.json() as { name: string }).name, "Family Wilma");

    const workerResponse = await fetch(`http://127.0.0.1:${port}/sw.js`);
    assert.equal(workerResponse.status, 200);
    assert.match(workerResponse.headers.get("content-type") ?? "", /text\/javascript/);
    assert.equal(workerResponse.headers.get("service-worker-allowed"), "/");
    assert.match(await workerResponse.text(), /family-wilma-/);

    const iconResponse = await fetch(`http://127.0.0.1:${port}/icon-192.png`);
    assert.equal(iconResponse.status, 200);
    assert.equal(iconResponse.headers.get("content-type"), "image/png");
    assert.ok((await iconResponse.arrayBuffer()).byteLength > 1_000);

    for (const [method, path] of [
      ["GET", "/"],
      ["GET", "/homework"],
      ["GET", "/messages"],
      ["GET", "/setup"],
      ["GET", "/oauth/google/calendar/start"],
      ["GET", "/setup/discover?account=school"],
      ["POST", "/homework/refresh"],
      ["POST", "/messages/refresh"],
      ["POST", "/messages/analyze"],
      ["POST", "/mfa"],
      ["POST", "/logout"],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, redirect: "manual" });
      assert.equal(response.status, 303, `${method} ${path}`);
      assert.match(response.headers.get("location") ?? "", /^\/oauth\/google\/start/);
    }

    const start = await fetch(`http://127.0.0.1:${port}/oauth/google/start?returnTo=%2Fsetup`, { redirect: "manual" });
    assert.equal(start.status, 303);
    assert.match(start.headers.get("set-cookie") ?? "", /^family_wilma_oauth_state=/);
    const googleUrl = new URL(start.headers.get("location") ?? "");
    assert.equal(googleUrl.hostname, "accounts.google.com");
    assert.ok(googleUrl.searchParams.get("state"));
    assert.match(googleUrl.searchParams.get("scope") ?? "", /openid/);
    assert.doesNotMatch(googleUrl.searchParams.get("scope") ?? "", /calendar\.app\.created/);

    const invalidCallback = await fetch(`http://127.0.0.1:${port}/oauth/google/callback?code=fake`, { redirect: "manual" });
    assert.equal(invalidCallback.status, 400);

    const token = "test-session-token";
    const now = Math.floor(Date.now() / 1000);
    const db = new DatabaseSync(join(dataDir, "family-wilma.sqlite"));
    db.prepare(`
      INSERT INTO user_sessions (token_hash, expires_at, created_at, last_seen_at, email)
      VALUES (?, ?, ?, ?, ?)
    `).run(createHash("sha256").update(token).digest("hex"), now + 3600, now, now, "owner@example.com");
    db.prepare(`
      INSERT INTO user_sessions (token_hash, expires_at, created_at, last_seen_at, email)
      VALUES (?, ?, ?, ?, ?)
    `).run(createHash("sha256").update("removed-member-token").digest("hex"), now + 3600, now, now, "removed@example.com");
    db.close();

    const removedMember = await fetch(`http://127.0.0.1:${port}/setup`, {
      headers: { cookie: "family_wilma_session=removed-member-token" },
      redirect: "manual",
    });
    assert.equal(removedMember.status, 303);
    assert.match(removedMember.headers.get("location") ?? "", /^\/oauth\/google\/start/);

    const signedIn = await fetch(`http://127.0.0.1:${port}/setup`, {
      headers: { cookie: `family_wilma_session=${token}` },
    });
    assert.equal(signedIn.status, 200);
    assert.match(await signedIn.text(), /Kirjaudu ulos/);

    const calendarStart = await fetch(`http://127.0.0.1:${port}/oauth/google/calendar/start?returnTo=%2Fsetup`, {
      headers: { cookie: `family_wilma_session=${token}` },
      redirect: "manual",
    });
    assert.equal(calendarStart.status, 303);
    const calendarGoogleUrl = new URL(calendarStart.headers.get("location") ?? "");
    assert.match(calendarGoogleUrl.searchParams.get("scope") ?? "", /calendar\.app\.created/);
    assert.match(calendarGoogleUrl.searchParams.get("scope") ?? "", /calendar\.acls/);

    const signedInHome = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { cookie: `family_wilma_session=${token}` },
    });
    assert.equal(signedInHome.status, 200);
    const signedInHomeHtml = await signedInHome.text();
    assert.match(signedInHomeHtml, /href="\/homework">Kotitehtävät/);
    assert.match(signedInHomeHtml, /href="\/messages">Viestit/);
    assert.doesNotMatch(signedInHomeHtml, /calendar\/sync/);
    assert.match(signedInHomeHtml, /rel="manifest" href="\/manifest\.webmanifest"/);
    assert.match(signedInHomeHtml, /<script defer src="\/pwa\.js"><\/script>/);

    const homeworkStartedAt = Date.now();
    const homework = await fetch(`http://127.0.0.1:${port}/homework`, {
      headers: { cookie: `family_wilma_session=${token}` },
    });
    assert.equal(homework.status, 200);
    assert.ok(Date.now() - homeworkStartedAt < 1_000, "homework page must not wait for refresh");
    const homeworkHtml = await homework.text();
    assert.match(homeworkHtml, /Kotitehtävät/);
    assert.match(homeworkHtml, /action="\/homework\/refresh"/);
    assert.match(homeworkHtml, /Päivitä nyt|Päivitetään…/);

    const messages = await fetch(`http://127.0.0.1:${port}/messages`, {
      headers: { cookie: `family_wilma_session=${token}` },
    });
    assert.equal(messages.status, 200);
    const messagesHtml = await messages.text();
    assert.match(messagesHtml, /30 päivää/);
    assert.match(messagesHtml, /Cached message/);
    assert.match(messagesHtml, /action="\/messages\/refresh"/);
    assert.match(messagesHtml, /Analysoi kaikki ja synkkaa kalenteri/);
    assert.match(messagesHtml, /data-message-filter="account:school"/);
    assert.match(messagesHtml, /data-message-filter="child:Test child"/);
    assert.match(messagesHtml, /data-transient-status="analysis-batch:fresh-completed-batch"/);
    assert.doesNotMatch(messagesHtml, /data-transient-status="analysis-batch:stale-completed-batch"/);
    assert.match(messagesHtml, /<script defer src="\/message-status\.js"><\/script>/);
    assert.match(messagesHtml, /<script defer src="\/message-filters\.js"><\/script>/);
    assert.doesNotMatch(messagesHtml, /type="checkbox"/);

    const groupedMessage = groupMessages([cachedMessage])[0];
    assert.ok(groupedMessage);
    new AnalysisStore(dataDir).put(analysisIdentity(groupedMessage), { calendarItems: [], hasOtherContent: false });
    const analyzedMessages = await fetch(`http://127.0.0.1:${port}/messages`, {
      headers: { cookie: `family_wilma_session=${token}` },
    });
    assert.equal(analyzedMessages.status, 200);
    assert.match(await analyzedMessages.text(), /<button type="submit" disabled>Kaikki viestit analysoitu<\/button>/);
    const redundantAnalysis = await fetch(`http://127.0.0.1:${port}/messages/analyze`, {
      method: "POST",
      headers: { cookie: `family_wilma_session=${token}` },
      redirect: "manual",
    });
    assert.equal(redundantAnalysis.status, 303);
    assert.equal(redundantAnalysis.headers.get("location"), "/messages");

    const logout = await fetch(`http://127.0.0.1:${port}/logout`, {
      method: "POST",
      headers: { cookie: `family_wilma_session=${token}` },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
    const afterLogout = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { cookie: `family_wilma_session=${token}` },
      redirect: "manual",
    });
    assert.equal(afterLogout.status, 303);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
