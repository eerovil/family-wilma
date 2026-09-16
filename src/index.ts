import Anthropic from "@anthropic-ai/sdk";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { loadConfig } from "./config.js";
import { analysisIdentities, analysisIdentity, MessageAnalyzer } from "./analysis.js";
import { AnalyzeSyncJob, type AnalyzeSyncSnapshot } from "./analyze-sync.js";
import { AnalysisBatchService, type AnalysisBatchAdapter } from "./batch-analysis.js";
import { ManualAnalysisAdapter } from "./manual-analysis.js";
import { GoogleCalendarService } from "./google.js";
import { UnauthorizedGoogleAccountError } from "./google.js";
import { clearOAuthStateCookie, clearSessionCookie, oauthStateCookie, oauthStateToken, safeReturnPath, sessionCookie, sessionToken, SessionStore } from "./auth.js";
import { MESSAGE_CARD_CSS, renderMessageCard, renderMessageFilters } from "./message-view.js";
import { AnalysisStore } from "./store.js";
import { MfaCodeRequiredError, WilmaService, type FetchedMessage } from "./wilma.js";
import { MessageLoadJob, type MessageLoadSnapshot } from "./message-load.js";
import { configureErrorReportingSecrets, flushErrorReporting, initializeErrorReporting, reportError } from "./telemetry.js";
import { PedanetHomeworkService } from "./pedanet-homework.js";
import { HOMEWORK_VIEW_CSS, renderExamSection, renderHomeworkContent } from "./homework-view.js";
import { HomeworkCacheStore, homeworkCacheIdentity, wilmaCacheIdentity } from "./homework-cache.js";
import { HomeworkRefreshJob, type HomeworkRefreshSnapshot } from "./homework-refresh.js";
import { MessageCacheStore } from "./message-cache.js";
import { groupMessages, type GroupedMessage } from "./message-group.js";
import { messageCalendarProjection, type AnalyzedMessage } from "./message-calendar.js";
import { transientStatus } from "./message-status.js";
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
const wilma = new WilmaService(config, () => new Date(), {
  onError: (error) => reportError(error, { operation: "homework.diary.fetch" }),
});
const pedanetHomework = config.pedanetHomeworkUrl && config.pedanetHomeworkModuleId
  ? new PedanetHomeworkService(config.pedanetHomeworkUrl, config.pedanetHomeworkModuleId)
  : null;
const homeworkCache = new HomeworkCacheStore(config.dataDir, {
  wilma: wilmaCacheIdentity(config.wilmaAccounts),
  pedanet: pedanetHomework
    ? homeworkCacheIdentity([config.pedanetHomeworkUrl, config.pedanetHomeworkModuleId, "recent-seven-days-v1"])
    : null,
  exams: wilmaCacheIdentity(config.wilmaAccounts),
});
const homeworkRefresh = new HomeworkRefreshJob({
  cache: homeworkCache,
  waitForWilmaTurn: async () => {
    while (otherWilmaOperationActive()) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  },
  fetchWilma: () => wilma.fetchHomework(),
  fetchExams: () => wilma.fetchExams(),
  ...(pedanetHomework ? { fetchPedanet: () => pedanetHomework.recent() } : {}),
  mfaAccountId: (error) => error instanceof MfaCodeRequiredError ? error.accountId : null,
  reportError: (error, source) => reportError(error, { operation: `homework.${source}.fetch` }),
});
const calendar = new GoogleCalendarService(config);
const sessions = new SessionStore(config.dataDir);
const secureCookies = config.baseUrl.startsWith("https://");
const messageCache = new MessageCacheStore(config.dataDir, wilmaCacheIdentity(config.wilmaAccounts));
const messageLoad = new MessageLoadJob({
  cache: messageCache,
  fetch: (options) => wilma.fetchAll(options),
  mfaAccountId: (error) => error instanceof MfaCodeRequiredError ? error.accountId : null,
  reportError: (error) => reportError(error, { operation: "message.load" }),
});
const analyzeSync = new AnalyzeSyncJob({
  submit: (messages) => batches.submit(messages),
  refresh: () => batches.refresh(),
  pending: (message) => analysisIdentities(message).some((identity) => store.hasPending(identity)),
  statuses: () => batches.statuses(),
  sync: async () => {
    const bundle = await wilma.fetchAll({
      sentAfter: new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000),
      includeLessons: true,
    });
    if (!bundle.lessonWindow) throw new Error("Lesson window was not returned");
    const messageProjection = messageCalendarProjection(cachedMessages(groupMessages(bundle.messages)));
    return await calendar.sync({
      sharedItems: [...bundle.structuredCalendarItems, ...messageProjection.items],
      sharedSupersededSourcePrefixes: messageProjection.supersededSourcePrefixes,
      droppedSourceIds: store.droppedCalendarSources(),
      lessonCalendars: bundle.lessonCalendars,
      lessonWindow: bundle.lessonWindow,
    });
  },
  mfaAccountId: (error) => error instanceof MfaCodeRequiredError ? error.accountId : null,
  reportError: (error) => reportError(error, { operation: "analysis_and_calendar.sync" }),
});

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function transientBanner(id: string, finishedAt: string | null, className: "error" | "success", content: string): string {
  const status = transientStatus(id, finishedAt);
  return status
    ? `<div class="${className}" data-transient-status="${escapeHtml(status.id)}" data-status-hide-after="${status.hideAfterMs}">${content}</div>`
    : "";
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

function home(email: string): string {
  const google = calendar.isConnected()
    ? '<span class="muted">Google Calendar yhdistetty</span>'
    : email === config.googleAllowedEmail
      ? '<a class="toplink" href="/oauth/google/calendar/start">Yhdistä Google Calendar</a>'
      : '<span class="muted">Kalenterin omistajan pitää yhdistää Google Calendar.</span>';
  return layout("Family Wilma", `
<h1>Family Wilma</h1>
<div class="actions">
  <a class="button" href="/homework">Kotitehtävät</a>
  <a class="button" href="/messages">Viestit</a>
</div>
<p>${google} · <a class="toplink" href="/setup">Asetukset</a></p>`);
}

function homeworkPage(snapshot: HomeworkRefreshSnapshot): string {
  if (snapshot.state === "mfa" && snapshot.mfaAccountId) {
    return mfaPage(snapshot.mfaAccountId, "/homework/refresh", "POST");
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
  const exams = hasCache || snapshot.state !== "running"
    ? renderExamSection({ exams: snapshot.exams, droppedSourceIds: new Set(store.droppedCalendarSources()) })
    : "";
  const refresh = homeworkRefreshStatus(snapshot);
  const refreshButton = snapshot.state === "running"
    ? '<button type="submit" disabled>Päivitetään…</button>'
    : '<button class="secondary" type="submit">Päivitä nyt</button>';
  return layout(
    "Kotitehtävät",
    `<p><a class="toplink" href="/">← Etusivulle</a></p><h1>Kotitehtävät</h1><form method="post" action="/homework/refresh">${refreshButton}</form>${refresh.html}${exams}${content}`,
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

function analyzeSyncStatus(snapshot: AnalyzeSyncSnapshot): { html: string; refresh: boolean } {
  if (snapshot.state === "analyzing") {
    return {
      html: '<div class="card"><strong>Viestejä analysoidaan…</strong><p class="muted">Kaikki viimeisten 30 päivän viestit käsitellään ennen kalenterin synkronointia. Sivun voi sulkea.</p></div>',
      refresh: true,
    };
  }
  if (snapshot.state === "syncing") {
    return {
      html: '<div class="card"><strong>Kalenteria synkronoidaan…</strong><p class="muted">Sivun voi sulkea. Työ jatkuu palvelimella.</p></div>',
      refresh: true,
    };
  }
  if (snapshot.state === "success" && snapshot.result) {
    const result = snapshot.result;
    return {
      html: transientBanner(`analyze-sync:success:${snapshot.finishedAt ?? "unknown"}`, snapshot.finishedAt, "success", `Synkronointi valmis: luotu ${result.created}, päivitetty ${result.updated}, poistettu ${result.deleted}, ennallaan ${result.unchanged}.`),
      refresh: false,
    };
  }
  if (snapshot.state === "error") {
    return {
      html: transientBanner(`analyze-sync:error:${snapshot.finishedAt ?? "unknown"}`, snapshot.finishedAt, "error", escapeHtml(snapshot.error ?? "Analysointi tai kalenterin synkronointi epäonnistui.")),
      refresh: false,
    };
  }
  return { html: "", refresh: false };
}

function cachedMessages(messages: GroupedMessage[]): AnalyzedMessage[] {
  return messages.flatMap((message) => {
    const analysis = analyzer.cached(message);
    return analysis ? [{ message, calendarItems: analysis.calendarItems, hasOtherContent: analysis.hasOtherContent }] : [];
  });
}

function messageLoadingPage(snapshot: MessageLoadSnapshot): string {
  if (snapshot.state === "mfa" && snapshot.mfaAccountId) {
    return mfaPage(snapshot.mfaAccountId, "/messages/refresh", "POST");
  }
  const sync = analyzeSync.snapshot();
  if (sync.state === "mfa" && sync.mfaAccountId) {
    return mfaPage(sync.mfaAccountId, "/messages/analyze", "POST");
  }
  return messagesPage(snapshot, sync);
}

function busyPage(message: string): string {
  return layout("Toiminto käynnissä", `<p><a class="toplink" href="/">← Etusivulle</a></p><h1>Toiminto käynnissä</h1><div class="card">${escapeHtml(message)}</div>`);
}

function messageCards(messages: GroupedMessage[]): string {
  const droppedSourceIds = new Set(store.droppedCalendarSources());
  return messages.map((message) => renderMessageCard({
    message,
    analysis: analyzer.cached(message),
    pending: analysisIdentities(message).some((identity) => store.hasPending(identity)),
    droppedSourceIds,
  })).join("");
}

function batchStatus(): { html: string; active: boolean } {
  const statuses = batches.statuses();
  const active = config.analysisMode === "anthropic" && statuses.some((status) => status.status === "in_progress");
  const html = statuses.flatMap((status) => {
    if (status.status === "submitting") {
      return [config.analysisMode === "manual"
        ? '<div class="error">Paikallisen analyysipyynnön tallennus jäi kesken.</div>'
        : '<div class="error">Batch-lähetyksen tila jäi epävarmaksi. Viestejä ei lähetetä automaattisesti uudelleen.</div>'];
    }
    if (config.analysisMode === "manual" && status.status === "in_progress") {
      return [`<div class="card"><strong>Odottaa paikallista agenttianalyysiä</strong><p class="muted">${status.total} viestiä jonossa. Viestejä ei lähetetty Anthropic APIin.</p></div>`];
    }
    if (status.status === "in_progress") {
      return [`<div class="card"><strong>Batch-analyysi käynnissä</strong><p class="muted">${status.total} viestiä · valmiina ${status.succeeded + status.failed}/${status.total}</p></div>`];
    }
    const completed = transientBanner(`analysis-batch:${status.batchId}`, status.updatedAt, "success", `Batch-analyysi valmis: ${status.imported} analysoitu${status.failed ? `, ${status.failed} epäonnistui` : ""}.`);
    return completed ? [completed] : [];
  }).slice(0, 3).join("");
  return { html, active };
}

function messagesPage(load: MessageLoadSnapshot, sync: AnalyzeSyncSnapshot): string {
  const batchesState = batchStatus();
  const syncState = analyzeSyncStatus(sync);
  const active = load.state === "fetching" || syncState.refresh;
  const saved = load.updatedAt ? `<p class="muted">Tallennettu ${escapeHtml(formatTimestamp(load.updatedAt))}</p>` : "";
  const loadStatus = load.state === "fetching"
    ? `<div class="card"><strong>Viestejä päivitetään…</strong>${saved}<p class="muted">Näytetään tallennetut viestit. Päivitys jatkuu taustalla.</p></div>`
    : load.state === "error"
      ? `<div class="error">${escapeHtml(load.error ?? "Viestien päivittäminen epäonnistui.")}</div>${saved}`
      : saved;
  const refreshButton = active
    ? '<button class="secondary" type="submit" disabled>Päivitetään…</button>'
    : '<button class="secondary" type="submit">Päivitä viestit</button>';
  const groupedMessages = groupMessages(load.messages);
  const hasUnanalyzed = groupedMessages.some((message) => !analyzer.cached(message));
  const analyzeDisabled = active || !hasUnanalyzed;
  const analyzeLabel = hasUnanalyzed
    ? config.analysisMode === "manual" ? "Jonota kaikki ja synkkaa kalenteri" : "Analysoi kaikki ja synkkaa kalenteri"
    : "Kaikki viestit analysoitu";
  const analyzeButton = load.messages.length
    ? `<form method="post" action="/messages/analyze"><button type="submit"${analyzeDisabled ? " disabled" : ""}>${analyzeLabel}</button></form>`
    : "";
  const filters = renderMessageFilters(groupedMessages);
  const cards = messageCards(groupedMessages) || '<p class="muted">Ei viestejä.</p>';
  return layout("Viimeiset 30 päivää", `<p><a class="toplink" href="/">← Etusivulle</a></p><h1>Viimeiset 30 päivää</h1>
  <form method="post" action="/messages/refresh">${refreshButton}</form>${loadStatus}${syncState.html}${batchesState.html}${analyzeButton}${filters}${cards}<script defer src="/message-status.js"></script><script defer src="/message-filters.js"></script>`,
  active || batchesState.active ? '<meta http-equiv="refresh" content="5">' : "");
}

function mfaPage(accountId: string, returnTo: string, returnMethod: "GET" | "POST"): string {
  return layout("Wilma MFA", `<p><a class="toplink" href="/">← Etusivulle</a></p><h1>Wilma tarvitsee MFA-koodin</h1>
<p>Tilille <strong>${escapeHtml(accountId)}</strong> tarvitaan kertakäyttöinen vahvistuskoodi. Koodia ei tallenneta levylle.</p>
<form method="post" action="/mfa"><input type="hidden" name="accountId" value="${escapeHtml(accountId)}"><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}"><input type="hidden" name="returnMethod" value="${returnMethod}"><label>Koodi<input name="code" inputmode="numeric" autocomplete="one-time-code" required></label><p><button type="submit">Jatka</button></p></form>`);
}

function setupPage(email: string): string {
  const accounts = config.wilmaAccounts.map((account) => `<div class="card"><strong>${escapeHtml(account.id)}</strong><div class="muted">${escapeHtml(account.baseUrl)} · ${escapeHtml(account.username)}</div><p>Kaikki Wilman profiilit otetaan mukaan automaattisesti.</p>${account.profiles.length ? `<div class="muted">Nimien korvaukset:</div><ul>${account.profiles.map((profile) => `<li>${escapeHtml(profile.studentNumber)} → ${escapeHtml(profile.child)}</li>`).join("")}</ul>` : ""}<a class="toplink" href="/setup/discover?account=${encodeURIComponent(account.id)}">Näytä löydetyt Wilma-profiilit</a></div>`).join("");
  const calendarStatus = calendar.isConnected()
    ? "Google Calendar on yhdistetty."
    : email === config.googleAllowedEmail
      ? '<a class="toplink" href="/oauth/google/calendar/start?returnTo=%2Fsetup">Yhdistä Google Calendar</a>'
      : "Kalenterin omistajan pitää yhdistää Google Calendar.";
  return layout("Asetukset", `<p><a class="toplink" href="/">← Etusivulle</a></p><h1>Asetukset</h1><h2>Wilma-tilit</h2>${accounts || '<p class="error">WILMA_ACCOUNTS_JSON ei sisällä tilejä.</p>'}<h2>Google</h2><p>${calendarStatus}</p><p class="muted">Kirjautunut: ${escapeHtml(email)}</p><form method="post" action="/logout"><button class="secondary" type="submit">Kirjaudu ulos</button></form>`);
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
      const state = sessions.createOAuthState(url.searchParams.get("returnTo"), "login");
      res.setHeader("set-cookie", oauthStateCookie(state, secureCookies));
      return redirect(res, calendar.authUrl(state, "login"));
    }
    if (req.method === "GET" && url.pathname === "/oauth/google/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state") ?? "";
      const browserState = oauthStateToken(req.headers.cookie, secureCookies);
      res.setHeader("set-cookie", clearOAuthStateCookie(secureCookies));
      if (!browserState || browserState !== state) {
        return send(res, 400, layout("Google OAuth", '<div class="error">Google-kirjautumisen vahvistus epäonnistui.</div>'));
      }
      const oauthState = sessions.consumeOAuthState(state);
      if (!code || !oauthState) return send(res, 400, layout("Google OAuth", '<div class="error">Google-kirjautumisen vahvistus epäonnistui.</div>'));
      const email = await calendar.handleCallback(code, oauthState.purpose);
      const token = sessions.createSession(email);
      res.setHeader("set-cookie", [clearOAuthStateCookie(secureCookies), sessionCookie(token, secureCookies)]);
      return redirect(res, oauthState.returnTo);
    }

    const token = sessionToken(req.headers.cookie, secureCookies);
    const signedIn = sessions.authenticate(token);
    if (!signedIn) {
      const returnTo = req.method === "GET" ? `${url.pathname}${url.search}` : "/";
      return redirect(res, `/oauth/google/start?returnTo=${encodeURIComponent(returnTo)}`);
    }
    const email = sessions.sessionEmail(token);
    if (!email || !config.googleAllowedLoginEmails.includes(email)) {
      sessions.destroySession(token);
      res.setHeader("set-cookie", clearSessionCookie(secureCookies));
      return redirect(res, `/oauth/google/start?returnTo=${encodeURIComponent(url.pathname)}`);
    }
    if (token) res.setHeader("set-cookie", sessionCookie(token, secureCookies));

    if (req.method === "GET" && url.pathname === "/oauth/google/calendar/start") {
      if (email !== config.googleAllowedEmail) {
        return send(res, 403, layout("Google Calendar", '<div class="error">Vain kalenterin omistaja voi yhdistää Google Calendarin.</div>'));
      }
      const state = sessions.createOAuthState(url.searchParams.get("returnTo"), "calendar");
      res.setHeader("set-cookie", oauthStateCookie(state, secureCookies));
      return redirect(res, calendar.authUrl(state, "calendar"));
    }

    if (req.method === "GET" && url.pathname === "/") return send(res, 200, home(email));
    if (req.method === "GET" && url.pathname === "/homework") {
      homeworkRefresh.start({ force: false });
      return send(res, 200, homeworkPage(homeworkRefresh.snapshot()));
    }
    if (req.method === "POST" && url.pathname === "/homework/refresh") {
      if (otherWilmaOperationActive()) {
        return send(res, 409, busyPage("Toinen Wilma-toiminto on vielä käynnissä. Yritä kotitehtävien päivittämistä sen valmistuttua."));
      }
      const runId = homeworkRefresh.start({ force: true });
      return redirect(res, `/homework?run=${encodeURIComponent(runId ?? "pending")}`);
    }
    if (req.method === "POST" && url.pathname === "/calendar/drop") {
      const form = await readForm(req);
      const sourceId = form.get("sourceId")?.trim();
      if (!sourceId) return send(res, 400, busyPage("Kalenterikohdetta ei tunnistettu."));
      // An unchecked checkbox is simply absent from the post, which is the drop.
      store.setCalendarSourceDropped(sourceId, form.get("keep") !== "1");
      // The in-page save wants no navigation at all; a no-script post still redirects.
      if (req.headers["x-family-wilma-async"] === "1") {
        res.writeHead(204, { "cache-control": "no-store" });
        res.end();
        return;
      }
      return redirect(res, safeReturnPath(form.get("returnTo")));
    }
    if (req.method === "GET" && url.pathname === "/setup") return send(res, 200, setupPage(email));
    if (req.method === "POST" && url.pathname === "/logout") {
      sessions.destroySession(token);
      res.setHeader("set-cookie", clearSessionCookie(secureCookies));
      return send(res, 200, layout("Kirjauduttu ulos", '<h1>Kirjauduttu ulos</h1><p><a class="toplink" href="/oauth/google/start">Kirjaudu uudelleen Googlella</a></p>'));
    }
    if (req.method === "POST" && url.pathname === "/messages/refresh") {
      const homework = homeworkRefresh.snapshot();
      if (homework.state === "running" || homework.state === "mfa") {
        return send(res, 409, busyPage("Kotitehtävien päivitys on vielä käynnissä. Yritä viestien lataamista sen valmistuttua."));
      }
      const syncState = analyzeSync.snapshot().state;
      if (syncState === "analyzing" || syncState === "syncing" || syncState === "mfa") {
        return send(res, 409, busyPage("Analysointi tai kalenterin synkronointi on vielä käynnissä. Yritä viestien päivittämistä sen valmistuttua."));
      }
      messageLoad.start({ force: true });
      return redirect(res, "/messages");
    }
    if (req.method === "GET" && url.pathname === "/messages") {
      void batches.refresh().catch((error) => reportError(error, { operation: "analysis.batch.refresh" }));
      const homeworkState = homeworkRefresh.snapshot().state;
      const syncState = analyzeSync.snapshot().state;
      if (homeworkState !== "running" && homeworkState !== "mfa"
        && syncState !== "analyzing" && syncState !== "syncing" && syncState !== "mfa") {
        messageLoad.start({ force: false });
      }
      return send(res, 200, messageLoadingPage(messageLoad.snapshot()));
    }
    if (req.method === "POST" && url.pathname === "/messages/analyze") {
      const homework = homeworkRefresh.snapshot();
      if (homework.state === "running" || homework.state === "mfa") {
        return send(res, 409, busyPage("Kotitehtävien päivitys on vielä käynnissä. Yritä analysointia sen valmistuttua."));
      }
      const load = messageLoad.snapshot();
      if (load.state === "fetching" || load.state === "mfa") {
        return send(res, 409, messageLoadingPage(load));
      }
      if (!load.messages.length) return send(res, 409, messageLoadingPage(load));
      const messages = groupMessages(load.messages);
      if (messages.every((message) => Boolean(analyzer.cached(message)))) return redirect(res, "/messages");
      if (!calendar.isConnected()) {
        if (email !== config.googleAllowedEmail) {
          return send(res, 409, busyPage("Kalenterin omistajan pitää yhdistää Google Calendar ennen synkronointia."));
        }
        return redirect(res, "/oauth/google/calendar/start?returnTo=%2Fmessages");
      }
      if (!analyzeSync.start(messages)) {
        return send(res, 409, busyPage("Analysointi tai kalenterin synkronointi on jo käynnissä."));
      }
      return redirect(res, "/messages");
    }
    if (req.method === "POST" && url.pathname === "/mfa") {
      const form = await readForm(req);
      const accountId = form.get("accountId") ?? "";
      const code = form.get("code") ?? "";
      const returnTo = form.get("returnTo") || "/";
      const returnMethod = form.get("returnMethod") === "POST" ? "POST" : "GET";
      const safeReturnTo = safeReturnPath(returnTo);
      if (returnMethod === "POST" && safeReturnTo === "/homework/refresh") {
        if (!homeworkRefresh.claimMfa(accountId)) {
          return send(res, 409, layout("Wilma MFA", '<div class="error">MFA-pyyntö ei ole enää voimassa.</div><p><a class="toplink" href="/homework">Takaisin kotitehtäviin</a></p>'));
        }
        wilma.submitMfaCode(accountId, code);
        const runId = homeworkRefresh.start({ force: true });
        return redirect(res, `/homework?run=${encodeURIComponent(runId ?? "pending")}`);
      }
      if (returnMethod === "POST" && safeReturnTo === "/messages/analyze") {
        if (!analyzeSync.claimMfa(accountId)) {
          return send(res, 409, layout("Wilma MFA", '<div class="error">MFA-pyyntö ei ole enää voimassa.</div><p><a class="toplink" href="/messages">Takaisin viesteihin</a></p>'));
        }
        wilma.submitMfaCode(accountId, code);
        analyzeSync.start([]);
        return redirect(res, "/messages");
      }
      if (returnMethod === "POST" && safeReturnTo === "/messages/refresh") {
        if (!messageLoad.claimMfa(accountId)) {
          return send(res, 409, layout("Wilma MFA", '<div class="error">MFA-pyyntö ei ole enää voimassa.</div><p><a class="toplink" href="/messages">Takaisin viesteihin</a></p>'));
        }
        wilma.submitMfaCode(accountId, code);
        messageLoad.start({ force: true });
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
  const syncState = analyzeSync.snapshot().state;
  return messages === "fetching" || messages === "mfa"
    || syncState === "analyzing" || syncState === "syncing" || syncState === "mfa";
}

function knownRoute(pathname: string): string {
  return new Set([
    "/", "/healthz", "/oauth/google/start", "/oauth/google/calendar/start", "/oauth/google/callback", "/setup",
    "/logout", "/homework", "/homework/refresh", "/messages", "/messages/refresh", "/messages/analyze", "/mfa",
    "/calendar/drop",
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
