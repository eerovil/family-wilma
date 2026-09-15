import Anthropic from "@anthropic-ai/sdk";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { loadConfig } from "./config.js";
import { analysisIdentity, MessageAnalyzer } from "./analysis.js";
import { AnalysisBatchService, type AnalysisBatchAdapter } from "./batch-analysis.js";
import { ManualAnalysisAdapter } from "./manual-analysis.js";
import { GoogleCalendarService } from "./google.js";
import { UnauthorizedGoogleAccountError } from "./google.js";
import { clearOAuthStateCookie, clearSessionCookie, oauthStateCookie, oauthStateToken, safeReturnPath, sessionCookie, sessionToken, SessionStore } from "./auth.js";
import { MESSAGE_CARD_CSS, renderMessageCard } from "./message-view.js";
import { AnalysisStore, type CalendarItem } from "./store.js";
import { MfaCodeRequiredError, WilmaService, type FetchedMessage, type SourceCalendarItem } from "./wilma.js";
import { MessageLoadJob, type MessageLoadSnapshot } from "./message-load.js";
import { CalendarSyncJob, type CalendarSyncSnapshot } from "./calendar-sync.js";
import { configureErrorReportingSecrets, flushErrorReporting, initializeErrorReporting, reportError } from "./telemetry.js";
import { PedanetHomeworkService } from "./pedanet-homework.js";
import { HOMEWORK_VIEW_CSS, renderHomeworkContent } from "./homework-view.js";
import { HomeworkCacheStore, homeworkCacheIdentity, wilmaHomeworkCacheIdentity } from "./homework-cache.js";
import { HomeworkRefreshJob, type HomeworkRefreshSnapshot } from "./homework-refresh.js";
import { THEME_COLOR } from "./pwa-content.js";
import { pwaAsset } from "./pwa.js";

initializeErrorReporting({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT,
  release: process.env.SENTRY_RELEASE,
});
let fatalErrorInProgress = false;
function reportFatal(error: unknown, operation: string): void {
  if (fatalErrorInProgress) return;
  fatalErrorInProgress = true;
  reportError(error, { operation });
  void flushErrorReporting().finally(() => process.exit(1));
}
process.on("uncaughtException", (error) => reportFatal(error, "process.uncaught"));
process.on("unhandledRejection", (reason) => reportFatal(reason, "process.unhandled_rejection"));

const config = loadConfig();
configureErrorReportingSecrets([
  config.anthropicApiKey,
  config.googleClientSecret,
  ...config.wilmaAccounts.flatMap((account) => [account.username, account.password]),
].filter((value): value is string => Boolean(value)));
const store = new AnalysisStore(config.dataDir);
const anthropic = config.analysisMode === "anthropic"
  ? new Anthropic({ apiKey: config.anthropicApiKey! })
  : null;
const analyzer = new MessageAnalyzer(config.anthropicApiKey, store, anthropic ?? undefined);
const batches: AnalysisBatchAdapter = config.analysisMode === "manual"
  ? new ManualAnalysisAdapter(config.dataDir, store)
  : new AnalysisBatchService(store, analyzer, anthropic!);
const wilma = new WilmaService(config);
const pedanetHomework = config.pedanetHomeworkUrl && config.pedanetHomeworkModuleId
  ? new PedanetHomeworkService(config.pedanetHomeworkUrl, config.pedanetHomeworkModuleId)
  : null;
const homeworkCache = new HomeworkCacheStore(config.dataDir, {
  wilma: wilmaHomeworkCacheIdentity(config.wilmaAccounts),
  pedanet: pedanetHomework
    ? homeworkCacheIdentity([config.pedanetHomeworkUrl, config.pedanetHomeworkModuleId])
    : null,
});
const homeworkRefresh = new HomeworkRefreshJob({
  cache: homeworkCache,
  waitForWilmaTurn: async () => {
    while (otherWilmaOperationActive()) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  },
  fetchWilma: () => wilma.fetchHomework(),
  ...(pedanetHomework ? { fetchPedanet: () => pedanetHomework.latest() } : {}),
  mfaAccountId: (error) => error instanceof MfaCodeRequiredError ? error.accountId : null,
  reportError: (error, source) => reportError(error, { operation: `homework.${source}.fetch` }),
});
const calendar = new GoogleCalendarService(config);
const sessions = new SessionStore(config.dataDir);
const secureCookies = config.baseUrl.startsWith("https://");
const messageLoad = new MessageLoadJob({
  fetch: (options) => wilma.fetchAll(options),
  mfaAccountId: (error) => error instanceof MfaCodeRequiredError ? error.accountId : null,
  reportError: (error) => reportError(error, { operation: "message.load" }),
});
const calendarSync = new CalendarSyncJob({
  sync: async () => {
    await batches.refresh().catch((error) => reportError(error, { operation: "analysis.batch.refresh" }));
    const bundle = await wilma.fetchAll({
      sentAfter: new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000),
      includeLessons: true,
    });
    if (!bundle.lessonWindow) throw new Error("Lesson window was not returned");
    return await calendar.sync({
      sharedItems: [...bundle.structuredCalendarItems, ...messageCalendarItems(cachedMessages(bundle.messages))],
      lessonCalendars: bundle.lessonCalendars,
      lessonWindow: bundle.lessonWindow,
    });
  },
  mfaAccountId: (error) => error instanceof MfaCodeRequiredError ? error.accountId : null,
  reportError: (error) => reportError(error, { operation: "calendar.sync" }),
});

interface AnalyzedMessage {
  message: FetchedMessage;
  calendarItems: CalendarItem[];
  hasOtherContent: boolean;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function layout(title: string, body: string, head = ""): string {
  return `<!doctype html>
<html lang="fi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <meta name="theme-color" content="${THEME_COLOR}"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default">
    <link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
    <title>${escapeHtml(title)}</title>${head}<style>
:root{font-family:system-ui,-apple-system,sans-serif;color:#18212f;background:#f5f7fb}body{margin:0}.wrap{max-width:860px;margin:0 auto;padding:24px 16px 48px}h1{margin:16px 0 28px}.actions{display:grid;gap:18px;margin:48px auto;max-width:520px}.button,button{display:block;width:100%;box-sizing:border-box;border:0;border-radius:14px;padding:18px 20px;background:#1d4ed8;color:white;font-size:1.08rem;font-weight:700;text-align:center;text-decoration:none;cursor:pointer}button:disabled{background:#94a3b8;cursor:wait}.secondary{background:#e5e7eb;color:#111827}.card{background:white;border-radius:14px;padding:18px;margin:14px 0;box-shadow:0 1px 4px #0002}.important{border-left:6px solid #dc2626}.muted{color:#667085;font-size:.92rem}.pill{display:inline-block;background:#e0e7ff;color:#3730a3;border-radius:99px;padding:3px 8px;margin-right:6px;font-size:.82rem}.error{background:#fee2e2;color:#991b1b;padding:14px;border-radius:12px}.success{background:#dcfce7;color:#166534;padding:14px;border-radius:12px}.analyze-bar{position:sticky;bottom:10px;z-index:2;background:#f5f7fbee;padding:10px 0}form.inline{display:flex;gap:8px;align-items:end}label{display:block;font-weight:600}input{width:100%;box-sizing:border-box;padding:11px;border:1px solid #cbd5e1;border-radius:9px}.select{display:flex;gap:10px;align-items:center}.select input{width:auto}.toplink{color:#1d4ed8;text-decoration:none}${MESSAGE_CARD_CSS}@media(max-width:520px){.wrap{padding:18px 12px}.actions{margin:32px 0}.button,button{padding:17px 14px}}
  </style><style>${HOMEWORK_VIEW_CSS}</style></head><body><main class="wrap">${body}</main><script defer src="/pwa.js"></script></body></html>`;
}

function home(): string {
  const sync = calendarSync.snapshot();
  if (sync.state === "mfa" && sync.mfaAccountId) return mfaPage(sync.mfaAccountId, "/calendar/sync", "POST");
  const google = calendar.isConnected()
    ? '<span class="muted">Google Calendar yhdistetty</span>'
    : '<a class="toplink" href="/oauth/google/start">Yhdistä Google Calendar</a>';
  const syncStatus = calendarSyncStatus(sync);
  const syncButton = sync.state === "running"
    ? '<button type="submit" disabled>Synkronointi käynnissä…</button>'
    : '<button type="submit">Synkkaa kalenteriin</button>';
  return layout("Family Wilma", `
<h1>Family Wilma</h1>
<div class="actions">
  <a class="button" href="/homework">Kotitehtävät</a>
  <form method="post" action="/messages"><button type="submit">Näytä viimeiset 30 päivää</button></form>
  <form method="post" action="/calendar/sync">${syncButton}</form>
</div>
${syncStatus.html}<p>${google} · <a class="toplink" href="/setup">Asetukset</a></p>`, syncStatus.refresh ? '<meta http-equiv="refresh" content="3">' : "");
}

function homeworkPage(snapshot: HomeworkRefreshSnapshot): string {
  if (snapshot.state === "mfa" && snapshot.mfaAccountId) {
    return mfaPage(snapshot.mfaAccountId, "/homework", "GET");
  }
  const hasCache = Boolean(snapshot.wilmaUpdatedAt || snapshot.pedanetUpdatedAt);
  const content = hasCache || snapshot.state !== "running"
    ? renderHomeworkContent({
      homework: snapshot.homework,
      wilmaError: snapshot.wilmaError && !snapshot.wilmaUpdatedAt,
      pedanet: snapshot.pedanet,
      pedanetError: snapshot.pedanetError && !snapshot.pedanetUpdatedAt,
      pedanetSourceUrl: config.pedanetHomeworkUrl,
    })
    : "";
  const refresh = homeworkRefreshStatus(snapshot);
  return layout(
    "Kotitehtävät",
    `<p><a class="toplink" href="/">← Etusivulle</a></p><h1>Kotitehtävät</h1>${refresh.html}${content}`,
    refresh.pollUrl ? `<meta http-equiv="refresh" content="3;url=${escapeHtml(refresh.pollUrl)}">` : "",
  );
}

function homeworkRefreshStatus(snapshot: HomeworkRefreshSnapshot): { html: string; pollUrl: string | null } {
  const saved = homeworkSavedTimes(snapshot);
  if (snapshot.state === "running") {
    return { html: `<div class="card"><strong>Kotitehtäviä päivitetään…</strong>${saved}<p class="muted">Näytetään tallennetut tiedot. Päivitys jatkuu taustalla.</p></div>`, pollUrl: `/homework?run=${encodeURIComponent(snapshot.runId ?? "pending")}` };
  }
  if (snapshot.state === "error") {
    const errors = [
      snapshot.wilmaError ? staleSourceMessage("Wilma", snapshot.wilmaUpdatedAt) : "",
      snapshot.pedanetError ? staleSourceMessage("Peda.net", snapshot.pedanetUpdatedAt) : "",
    ].filter(Boolean).join("<br>");
    return { html: `<div class="error">${errors}</div>${saved}`, pollUrl: null };
  }
  if (snapshot.state === "success") {
    return { html: saved, pollUrl: null };
  }
  return { html: saved, pollUrl: null };
}

function homeworkSavedTimes(snapshot: HomeworkRefreshSnapshot): string {
  const lines = [
    snapshot.wilmaUpdatedAt ? `Wilma: ${formatTimestamp(snapshot.wilmaUpdatedAt)}` : "",
    snapshot.pedanetUpdatedAt ? `Peda.net: ${formatTimestamp(snapshot.pedanetUpdatedAt)}` : "",
  ].filter(Boolean);
  return lines.length ? `<p class="muted">Tallennettu ${lines.map(escapeHtml).join(" · ")}</p>` : "";
}

function staleSourceMessage(source: string, updatedAt: string | null): string {
  return updatedAt
    ? `${escapeHtml(source)}-päivitys epäonnistui. Näytetään versio ajalta ${escapeHtml(formatTimestamp(updatedAt))}.`
    : `${escapeHtml(source)}-päivitys epäonnistui, eikä tallennettua versiota ole.`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("fi-FI", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Helsinki" }).format(date);
}

function calendarSyncStatus(snapshot: CalendarSyncSnapshot): { html: string; refresh: boolean } {
  if (snapshot.state === "running") {
    return {
      html: '<div class="card"><strong>Kalenteria synkronoidaan…</strong><p class="muted">Sivun voi sulkea. Työ jatkuu palvelimella.</p></div>',
      refresh: true,
    };
  }
  if (snapshot.state === "success" && snapshot.result) {
    const result = snapshot.result;
    return {
      html: `<div class="success">Synkronointi valmis: luotu ${result.created}, päivitetty ${result.updated}, poistettu ${result.deleted}, ennallaan ${result.unchanged}.</div>`,
      refresh: false,
    };
  }
  if (snapshot.state === "error") {
    return { html: `<div class="error">${escapeHtml(snapshot.error ?? "Kalenterin synkronointi epäonnistui.")}</div>`, refresh: false };
  }
  return { html: "", refresh: false };
}

function cachedMessages(messages: FetchedMessage[]): AnalyzedMessage[] {
  return messages.flatMap((message) => {
    const analysis = analyzer.cached(message);
    return analysis ? [{ message, calendarItems: analysis.calendarItems, hasOtherContent: analysis.hasOtherContent }] : [];
  });
}

function messageLoadingPage(snapshot: MessageLoadSnapshot): string {
  if (snapshot.state === "idle") return layout("Viestit", `<p><a class="toplink" href="/">← Etusivulle</a></p><h1>Viestit</h1><p class="muted">Viestien latausta ei ole aloitettu.</p>`);
  if (snapshot.state === "mfa" && snapshot.mfaAccountId) {
    const returnTo = snapshot.includeOlder ? "/messages?scope=all" : "/messages";
    return mfaPage(snapshot.mfaAccountId, returnTo, "POST");
  }
  if (snapshot.state === "error") return layout("Viestit", `<p><a class="toplink" href="/">← Etusivulle</a></p><h1>Viestit</h1><div class="error">${escapeHtml(snapshot.error ?? "Viestien lataaminen epäonnistui.")}</div>`);
  if (snapshot.state === "ready") {
    const scope = snapshot.includeOlder ? "Kaikki viestit" : "Viimeiset 30 päivää";
    const older = snapshot.includeOlder ? "" : `<form method="post" action="/messages?scope=all"><button class="secondary" type="submit">Hae myös vanhemmat viestit</button></form>`;
    return messagesPage(snapshot.messages, scope, older);
  }
  const queued = snapshot.queuedIncludeOlder ? '<p class="muted">Vanhemmat viestit haetaan tämän jälkeen.</p>' : "";
  return layout("Viestit latautuvat", `<p><a class="toplink" href="/">← Etusivulle</a></p><h1>Viestit latautuvat</h1><div class="card"><strong>Haetaan viestejä Wilmasta…</strong><p class="muted">Sivun voi sulkea. Työ jatkuu palvelimella, eikä uusi painallus käynnistä toista työtä.</p>${queued}</div>`, '<meta http-equiv="refresh" content="3">');
}

function busyPage(message: string): string {
  return layout("Toiminto käynnissä", `<p><a class="toplink" href="/">← Etusivulle</a></p><h1>Toiminto käynnissä</h1><div class="card">${escapeHtml(message)}</div>`);
}

function selectionId(message: FetchedMessage): string {
  return Buffer.from(JSON.stringify([message.accountId, message.studentNumber, message.messageId])).toString("base64url");
}

function messageCards(messages: FetchedMessage[]): string {
  return messages.map((message) => renderMessageCard({
    message,
    analysis: analyzer.cached(message),
    pending: store.hasPending(analysisIdentity(message)),
    selectionId: selectionId(message),
  })).join("");
}

function hasSelectableMessages(messages: FetchedMessage[]): boolean {
  return messages.some((message) => !analyzer.cached(message) && !store.hasPending(analysisIdentity(message)));
}

function batchStatus(): { html: string; active: boolean } {
  const statuses = batches.statuses();
  const active = config.analysisMode === "anthropic" && statuses.some((status) => status.status === "in_progress");
  const html = statuses.slice(0, 3).map((status) => {
    if (status.status === "submitting") {
      return config.analysisMode === "manual"
        ? '<div class="error">Paikallisen analyysipyynnön tallennus jäi kesken.</div>'
        : '<div class="error">Batch-lähetyksen tila jäi epävarmaksi. Viestejä ei lähetetä automaattisesti uudelleen.</div>';
    }
    if (config.analysisMode === "manual" && status.status === "in_progress") {
      return `<div class="card"><strong>Odottaa paikallista agenttianalyysiä</strong><p class="muted">${status.total} viestiä jonossa. Viestejä ei lähetetty Anthropic APIin.</p></div>`;
    }
    return status.status === "in_progress"
      ? `<div class="card"><strong>Batch-analyysi käynnissä</strong><p class="muted">${status.total} viestiä · valmiina ${status.succeeded + status.failed}/${status.total}</p></div>`
      : `<div class="success">Batch-analyysi valmis: ${status.imported} analysoitu${status.failed ? `, ${status.failed} epäonnistui` : ""}.</div>`;
  }).join("");
  return { html, active };
}

function messagesPage(messages: FetchedMessage[], title = "Kaikki viestit", after = ""): string {
  const status = batchStatus();
  const cards = messageCards(messages);
  const submit = hasSelectableMessages(messages)
    ? `<div class="analyze-bar"><button type="submit">${config.analysisMode === "manual" ? "Jonota valitut agentille" : "Analysoi valitut batchina"}</button></div>`
    : "";
  const form = cards ? `<form method="post" action="/messages/analyze">${cards}${submit}</form>` : '<p class="muted">Ei viestejä.</p>';
  return layout(title, `<p><a class="toplink" href="/">← Etusivulle</a></p><h1>${escapeHtml(title)}</h1>${status.html}${form}${after}`, status.active ? '<meta http-equiv="refresh" content="10">' : "");
}

function mfaPage(accountId: string, returnTo: string, returnMethod: "GET" | "POST"): string {
  return layout("Wilma MFA", `<p><a class="toplink" href="/">← Etusivulle</a></p><h1>Wilma tarvitsee MFA-koodin</h1>
<p>Tilille <strong>${escapeHtml(accountId)}</strong> tarvitaan kertakäyttöinen vahvistuskoodi. Koodia ei tallenneta levylle.</p>
<form method="post" action="/mfa"><input type="hidden" name="accountId" value="${escapeHtml(accountId)}"><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}"><input type="hidden" name="returnMethod" value="${returnMethod}"><label>Koodi<input name="code" inputmode="numeric" autocomplete="one-time-code" required></label><p><button type="submit">Jatka</button></p></form>`);
}

function setupPage(email: string): string {
  const accounts = config.wilmaAccounts.map((account) => `<div class="card"><strong>${escapeHtml(account.id)}</strong><div class="muted">${escapeHtml(account.baseUrl)} · ${escapeHtml(account.username)}</div><p>Kaikki Wilman profiilit otetaan mukaan automaattisesti.</p>${account.profiles.length ? `<div class="muted">Nimien korvaukset:</div><ul>${account.profiles.map((profile) => `<li>${escapeHtml(profile.studentNumber)} → ${escapeHtml(profile.child)}</li>`).join("")}</ul>` : ""}<a class="toplink" href="/setup/discover?account=${encodeURIComponent(account.id)}">Näytä löydetyt Wilma-profiilit</a></div>`).join("");
  return layout("Asetukset", `<p><a class="toplink" href="/">← Etusivulle</a></p><h1>Asetukset</h1><h2>Wilma-tilit</h2>${accounts || '<p class="error">WILMA_ACCOUNTS_JSON ei sisällä tilejä.</p>'}<h2>Google</h2><p>${calendar.isConnected() ? "Google Calendar on yhdistetty." : '<a class="toplink" href="/oauth/google/start">Yhdistä Google Calendar</a>'}</p><p class="muted">Kirjautunut: ${escapeHtml(email)}</p><form method="post" action="/logout"><button class="secondary" type="submit">Kirjaudu ulos</button></form>`);
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}

function redirect(res: ServerResponse, location: string, status = 303): void {
  res.writeHead(status, { location, "cache-control": "no-store" });
  res.end();
}

function messageCalendarItems(analyzed: AnalyzedMessage[]): SourceCalendarItem[] {
  return analyzed.flatMap(({ message, calendarItems }) => calendarItems.map((item, index) => ({
    sourceId: `wilma-message:${message.accountId}:${message.studentNumber}:${message.messageId}:${index}`,
    title: `${message.child}: ${item.title}`,
    date: item.date,
    time: item.time,
    endDate: item.endDate,
    description: item.description ?? `Wilma-viesti: ${message.subject}`,
  })));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", config.baseUrl);
  try {
    if (req.method === "GET") {
      const asset = pwaAsset(url.pathname);
      if (asset) {
        res.writeHead(200, asset.headers);
        res.end(asset.body);
        return;
      }
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/oauth/google/start") {
      const state = sessions.createOAuthState(url.searchParams.get("returnTo"));
      res.setHeader("set-cookie", oauthStateCookie(state, secureCookies));
      return redirect(res, calendar.authUrl(state));
    }
    if (req.method === "GET" && url.pathname === "/oauth/google/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state") ?? "";
      const browserState = oauthStateToken(req.headers.cookie, secureCookies);
      res.setHeader("set-cookie", clearOAuthStateCookie(secureCookies));
      if (!browserState || browserState !== state) {
        return send(res, 400, layout("Google OAuth", '<div class="error">Google-kirjautumisen vahvistus epäonnistui.</div>'));
      }
      const returnTo = sessions.consumeOAuthState(state);
      if (!code || !returnTo) return send(res, 400, layout("Google OAuth", '<div class="error">Google-kirjautumisen vahvistus epäonnistui.</div>'));
      const email = await calendar.handleCallback(code);
      const token = sessions.createSession();
      res.setHeader("set-cookie", [clearOAuthStateCookie(secureCookies), sessionCookie(token, secureCookies)]);
      return redirect(res, returnTo);
    }

    const token = sessionToken(req.headers.cookie, secureCookies);
    const signedIn = sessions.authenticate(token);
    if (!signedIn) {
      const returnTo = req.method === "GET" ? `${url.pathname}${url.search}` : "/";
      return redirect(res, `/oauth/google/start?returnTo=${encodeURIComponent(returnTo)}`);
    }
    if (token) res.setHeader("set-cookie", sessionCookie(token, secureCookies));

    if (req.method === "GET" && url.pathname === "/") return send(res, 200, home());
    if (req.method === "GET" && url.pathname === "/homework") {
      const before = homeworkRefresh.snapshot();
      if (!url.searchParams.has("run") || before.state === "idle") homeworkRefresh.start();
      return send(res, 200, homeworkPage(homeworkRefresh.snapshot()));
    }
    if (req.method === "GET" && url.pathname === "/setup") return send(res, 200, setupPage(config.googleAllowedEmail));
    if (req.method === "POST" && url.pathname === "/logout") {
      sessions.destroySession(token);
      res.setHeader("set-cookie", clearSessionCookie(secureCookies));
      return send(res, 200, layout("Kirjauduttu ulos", '<h1>Kirjauduttu ulos</h1><p><a class="toplink" href="/oauth/google/start">Kirjaudu uudelleen Googlella</a></p>'));
    }
    if (req.method === "POST" && url.pathname === "/messages") {
      const homework = homeworkRefresh.snapshot();
      if (homework.state === "running" || homework.state === "mfa") {
        return send(res, 409, busyPage("Kotitehtävien päivitys on vielä käynnissä. Yritä viestien lataamista sen valmistuttua."));
      }
      if (calendarSync.snapshot().state === "running") {
        return send(res, 409, busyPage("Kalenterin synkronointi on vielä käynnissä. Yritä viestien lataamista sen valmistuttua."));
      }
      messageLoad.start({ includeOlder: url.searchParams.get("scope") === "all" });
      return redirect(res, "/messages");
    }
    if (req.method === "GET" && url.pathname === "/messages") {
      void batches.refresh().catch((error) => reportError(error, { operation: "analysis.batch.refresh" }));
      return send(res, 200, messageLoadingPage(messageLoad.snapshot()));
    }
    if (req.method === "POST" && url.pathname === "/messages/analyze") {
      const load = messageLoad.snapshot();
      if (load.state !== "ready") return send(res, 409, messageLoadingPage(load));
      const form = await readForm(req);
      const selected = new Set(form.getAll("message"));
      const messages = load.messages.filter((message) => selected.has(selectionId(message)));
      if (!messages.length) {
        return send(res, 400, messagesPage(load.messages, load.includeOlder ? "Kaikki viestit" : "Viimeiset 30 päivää", '<div class="error">Valitse vähintään yksi analysoitava viesti.</div>'));
      }
      await batches.submit(messages);
      return redirect(res, "/messages");
    }
    if (req.method === "POST" && url.pathname === "/calendar/sync") {
      if (!calendar.isConnected()) return redirect(res, "/oauth/google/start");
      const homework = homeworkRefresh.snapshot();
      if (homework.state === "running" || homework.state === "mfa") {
        return send(res, 409, busyPage("Kotitehtävien päivitys on vielä käynnissä. Yritä kalenterin synkronointia sen valmistuttua."));
      }
      const load = messageLoad.snapshot();
      if (load.state === "fetching" || load.state === "mfa") {
        return send(res, 409, messageLoadingPage(load));
      }
      calendarSync.start();
      return redirect(res, "/");
    }
    if (req.method === "POST" && url.pathname === "/mfa") {
      const form = await readForm(req);
      const accountId = form.get("accountId") ?? "";
      const code = form.get("code") ?? "";
      const returnTo = form.get("returnTo") || "/";
      const returnMethod = form.get("returnMethod") === "POST" ? "POST" : "GET";
      const safeReturnTo = safeReturnPath(returnTo);
      if (returnMethod === "GET" && safeReturnTo === "/homework") {
        if (!homeworkRefresh.claimMfa(accountId)) {
          return send(res, 409, layout("Wilma MFA", '<div class="error">MFA-pyyntö ei ole enää voimassa.</div><p><a class="toplink" href="/homework">Takaisin kotitehtäviin</a></p>'));
        }
        wilma.submitMfaCode(accountId, code);
        const runId = homeworkRefresh.start();
        return redirect(res, `/homework?run=${encodeURIComponent(runId)}`);
      }
      if (returnMethod === "POST" && safeReturnTo === "/calendar/sync") {
        if (!calendarSync.claimMfa(accountId)) {
          return send(res, 409, layout("Wilma MFA", '<div class="error">MFA-pyyntö ei ole enää voimassa.</div><p><a class="toplink" href="/">Takaisin etusivulle</a></p>'));
        }
        wilma.submitMfaCode(accountId, code);
        calendarSync.start();
        return redirect(res, "/");
      }
      if (returnMethod === "POST" && safeReturnTo.startsWith("/messages")) {
        if (!messageLoad.claimMfa(accountId)) {
          return send(res, 409, layout("Wilma MFA", '<div class="error">MFA-pyyntö ei ole enää voimassa.</div><p><a class="toplink" href="/messages">Takaisin viesteihin</a></p>'));
        }
        wilma.submitMfaCode(accountId, code);
        messageLoad.start({ includeOlder: new URL(safeReturnTo, config.baseUrl).searchParams.get("scope") === "all" });
        return redirect(res, "/messages");
      }
      wilma.submitMfaCode(accountId, code);
      return redirect(res, safeReturnTo, returnMethod === "POST" ? 307 : 303);
    }
    if (req.method === "GET" && url.pathname === "/setup/discover") {
      const accountId = url.searchParams.get("account") ?? "";
      const profiles = await wilma.discoverProfiles(accountId);
      const list = profiles.map((profile) => `<li><code>${escapeHtml(profile.studentNumber)}</code> — ${escapeHtml(profile.name)}</li>`).join("");
      return send(res, 200, layout("Wilma-profiilit", `<p><a class="toplink" href="/setup">← Asetuksiin</a></p><h1>Wilma-profiilit: ${escapeHtml(accountId)}</h1><ul>${list}</ul><p class="muted">Kaikki listatut profiilit otetaan mukaan automaattisesti Wilman näyttämillä nimillä.</p>`));
    }
    return send(res, 404, layout("Ei löytynyt", '<h1>404</h1><p><a class="toplink" href="/">Etusivulle</a></p>'));
  } catch (error) {
    if (error instanceof UnauthorizedGoogleAccountError) {
      return send(res, 403, layout("Pääsy estetty", '<div class="error">Tällä Google-tilillä ei ole pääsyä Family Wilmaan.</div>'));
    }
    if (error instanceof MfaCodeRequiredError) {
      const returnMethod = req.method === "POST" ? "POST" : "GET";
      return send(res, 409, mfaPage(error.accountId, `${url.pathname}${url.search}`, returnMethod));
    }
    reportError(error, {
      operation: "http.request",
      tags: { method: knownMethod(req.method), route: knownRoute(url.pathname) },
    });
    return send(res, 500, layout("Virhe", '<div class="error">Toiminto epäonnistui. Tarkista palvelimen asetukset ja yritä uudelleen.</div><p><a class="toplink" href="/">Etusivulle</a></p>'));
  }
}

function otherWilmaOperationActive(): boolean {
  const messages = messageLoad.snapshot().state;
  const calendarState = calendarSync.snapshot().state;
  return messages === "fetching" || messages === "mfa" || calendarState === "running" || calendarState === "mfa";
}

function knownRoute(pathname: string): string {
  return new Set([
    "/", "/healthz", "/oauth/google/start", "/oauth/google/callback", "/setup",
    "/logout", "/homework", "/messages", "/messages/analyze", "/calendar/sync", "/mfa",
    "/setup/discover",
  ]).has(pathname) ? pathname : "unknown";
}

function knownMethod(method: string | undefined): string {
  return new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).has(method ?? "")
    ? method!
    : "UNKNOWN";
}

const server = createServer((req, res) => { void handle(req, res); });
server.on("error", (error) => reportFatal(error, "server.listen"));
server.listen(config.port, config.host, () => {
  console.log(`family-wilma listening on port ${config.port}`);
});
