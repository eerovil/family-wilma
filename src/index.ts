import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { loadConfig } from "./config.js";
import { MessageAnalyzer } from "./analysis.js";
import { GoogleCalendarService } from "./google.js";
import { AnalysisStore, type CalendarItem } from "./store.js";
import { MfaCodeRequiredError, WilmaService, type FetchedMessage, type SourceCalendarItem } from "./wilma.js";

const config = loadConfig();
const store = new AnalysisStore(config.dataDir);
const analyzer = new MessageAnalyzer(config.anthropicApiKey, store);
const wilma = new WilmaService(config);
const calendar = new GoogleCalendarService(config);

interface AnalyzedMessage {
  message: FetchedMessage;
  calendarItems: CalendarItem[];
  hasOtherContent: boolean;
  cached: boolean;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="fi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
:root{font-family:system-ui,-apple-system,sans-serif;color:#18212f;background:#f5f7fb}body{margin:0}.wrap{max-width:860px;margin:0 auto;padding:24px 16px 48px}h1{margin:16px 0 28px}.actions{display:grid;gap:18px;margin:48px auto;max-width:520px}.button,button{display:block;width:100%;box-sizing:border-box;border:0;border-radius:14px;padding:18px 20px;background:#1d4ed8;color:white;font-size:1.08rem;font-weight:700;text-align:center;text-decoration:none;cursor:pointer}.secondary{background:#e5e7eb;color:#111827}.card{background:white;border-radius:14px;padding:18px;margin:14px 0;box-shadow:0 1px 4px #0002}.important{border-left:6px solid #dc2626}.muted{color:#667085;font-size:.92rem}.pill{display:inline-block;background:#e0e7ff;color:#3730a3;border-radius:99px;padding:3px 8px;margin-right:6px;font-size:.82rem}.error{background:#fee2e2;color:#991b1b;padding:14px;border-radius:12px}.success{background:#dcfce7;color:#166534;padding:14px;border-radius:12px}form.inline{display:flex;gap:8px;align-items:end}label{display:block;font-weight:600}input{width:100%;box-sizing:border-box;padding:11px;border:1px solid #cbd5e1;border-radius:9px}.toplink{color:#1d4ed8;text-decoration:none}.message-body{white-space:pre-wrap;line-height:1.45}.calendar{margin-top:12px;padding-top:10px;border-top:1px solid #e5e7eb}@media(max-width:520px){.wrap{padding:18px 12px}.actions{margin:32px 0}.button,button{padding:17px 14px}}
</style></head><body><main class="wrap">${body}</main></body></html>`;
}

function home(): string {
  const google = calendar.isConnected()
    ? '<span class="muted">Google Calendar yhdistetty</span>'
    : '<a class="toplink" href="/oauth/google/start">Yhdistä Google Calendar</a>';
  return layout("Family Wilma", `
<h1>Family Wilma</h1>
<div class="actions">
  <form method="post" action="/messages"><button type="submit">Näytä kaikki viestit</button></form>
  <form method="post" action="/calendar/sync"><button type="submit">Synkkaa kalenteriin</button></form>
</div>
<p>${google} · <a class="toplink" href="/setup">Asetukset</a></p>`);
}

async function analyzeMessages(messages: FetchedMessage[]): Promise<AnalyzedMessage[]> {
  const result: AnalyzedMessage[] = [];
  for (const message of messages) {
    const analyzed = await analyzer.analyze(message);
    result.push({
      message,
      calendarItems: analyzed.analysis.calendarItems,
      hasOtherContent: analyzed.analysis.hasOtherContent,
      cached: analyzed.cached,
    });
  }
  return result;
}

function messagesPage(messages: AnalyzedMessage[]): string {
  const cards = messages.map(({ message, calendarItems, hasOtherContent, cached }) => {
    const items = calendarItems.length
      ? `<div class="calendar"><strong>Kalenteriin:</strong>${calendarItems.map((item) => `<div>${escapeHtml(item.date)}${item.time ? ` ${escapeHtml(item.time)}` : ""} — ${escapeHtml(item.title)}</div>`).join("")}</div>`
      : "";
    return `<article class="card${hasOtherContent ? " important" : ""}">
<div><span class="pill">${escapeHtml(message.child)}</span>${hasOtherContent ? '<span class="pill">Sisältää muutakin tärkeää</span>' : ""}</div>
<h2>${escapeHtml(message.subject)}</h2>
<p class="muted">${escapeHtml(message.sender)} · ${escapeHtml(message.sentAt.toLocaleString("fi-FI", { timeZone: "Europe/Helsinki" }))} · ${cached ? "analyysi välimuistista" : "analysoitu nyt"}</p>
<div class="message-body">${escapeHtml(message.content)}</div>${items}</article>`;
  }).join("");
  return layout("Kaikki viestit", `<p><a class="toplink" href="/">← Etusivulle</a></p><h1>Kaikki viestit</h1>${cards || '<p class="muted">Ei viestejä.</p>'}`);
}

function mfaPage(error: MfaCodeRequiredError, returnTo: string): string {
  return layout("Wilma MFA", `<p><a class="toplink" href="/">← Etusivulle</a></p><h1>Wilma tarvitsee MFA-koodin</h1>
<p>Tilille <strong>${escapeHtml(error.accountId)}</strong> tarvitaan kertakäyttöinen vahvistuskoodi. Koodia ei tallenneta levylle.</p>
<form method="post" action="/mfa"><input type="hidden" name="accountId" value="${escapeHtml(error.accountId)}"><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}"><label>Koodi<input name="code" inputmode="numeric" autocomplete="one-time-code" required></label><p><button type="submit">Jatka</button></p></form>`);
}

function setupPage(): string {
  const accounts = config.wilmaAccounts.map((account) => `<div class="card"><strong>${escapeHtml(account.id)}</strong><div class="muted">${escapeHtml(account.baseUrl)} · ${escapeHtml(account.username)}</div><ul>${account.profiles.map((profile) => `<li>${escapeHtml(profile.studentNumber)} → ${escapeHtml(profile.child)}</li>`).join("")}</ul><a class="toplink" href="/setup/discover?account=${encodeURIComponent(account.id)}">Tarkista Wilman profiilit</a></div>`).join("");
  return layout("Asetukset", `<p><a class="toplink" href="/">← Etusivulle</a></p><h1>Asetukset</h1><h2>Wilma-tilit</h2>${accounts || '<p class="error">WILMA_ACCOUNTS_JSON ei sisällä tilejä.</p>'}<h2>Google</h2><p>${calendar.isConnected() ? "Google Calendar on yhdistetty." : '<a class="toplink" href="/oauth/google/start">Yhdistä Google Calendar</a>'}</p>`);
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

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, "cache-control": "no-store" });
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
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, home());
    if (req.method === "GET" && url.pathname === "/setup") return send(res, 200, setupPage());
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === "POST" && url.pathname === "/messages") {
      const bundle = await wilma.fetchAll();
      const analyzed = await analyzeMessages(bundle.messages);
      return send(res, 200, messagesPage(analyzed));
    }
    if (req.method === "POST" && url.pathname === "/calendar/sync") {
      if (!calendar.isConnected()) return redirect(res, "/oauth/google/start");
      const bundle = await wilma.fetchAll();
      const analyzed = await analyzeMessages(bundle.messages);
      const items = [...bundle.structuredCalendarItems, ...messageCalendarItems(analyzed)];
      const result = await calendar.sync(items);
      return send(res, 200, layout("Kalenteri synkattu", `<p><a class="toplink" href="/">← Etusivulle</a></p><h1>Kalenteri synkattu</h1><div class="success">Luotu ${result.created}, päivitetty ${result.updated}, ennallaan ${result.unchanged}.</div>`));
    }
    if (req.method === "POST" && url.pathname === "/mfa") {
      const form = await readForm(req);
      const accountId = form.get("accountId") ?? "";
      const code = form.get("code") ?? "";
      const returnTo = form.get("returnTo") || "/";
      wilma.submitMfaCode(accountId, code);
      return redirect(res, returnTo.startsWith("/") ? returnTo : "/");
    }
    if (req.method === "GET" && url.pathname === "/setup/discover") {
      const accountId = url.searchParams.get("account") ?? "";
      const profiles = await wilma.discoverProfiles(accountId);
      const list = profiles.map((profile) => `<li><code>${escapeHtml(profile.studentNumber)}</code> — ${escapeHtml(profile.name)}</li>`).join("");
      return send(res, 200, layout("Wilma-profiilit", `<p><a class="toplink" href="/setup">← Asetuksiin</a></p><h1>Wilma-profiilit: ${escapeHtml(accountId)}</h1><ul>${list}</ul><p class="muted">Muokkaa WILMA_ACCOUNTS_JSON-arvoon studentNumber → child -kartoitus ja käynnistä sovellus uudelleen.</p>`));
    }
    if (req.method === "GET" && url.pathname === "/oauth/google/start") return redirect(res, calendar.authUrl());
    if (req.method === "GET" && url.pathname === "/oauth/google/callback") {
      const code = url.searchParams.get("code");
      if (!code) return send(res, 400, layout("Google OAuth", '<div class="error">Google ei palauttanut valtuutuskoodia.</div>'));
      await calendar.handleCallback(code);
      return redirect(res, "/setup");
    }
    return send(res, 404, layout("Ei löytynyt", '<h1>404</h1><p><a class="toplink" href="/">Etusivulle</a></p>'));
  } catch (error) {
    if (error instanceof MfaCodeRequiredError) return send(res, 409, mfaPage(error, url.pathname));
    console.error(`request failed: ${error instanceof Error ? error.name : "Error"}`);
    return send(res, 500, layout("Virhe", '<div class="error">Toiminto epäonnistui. Tarkista palvelimen asetukset ja yritä uudelleen.</div><p><a class="toplink" href="/">Etusivulle</a></p>'));
  }
}

const server = createServer((req, res) => { void handle(req, res); });
server.listen(config.port, "0.0.0.0", () => {
  console.log(`family-wilma listening on port ${config.port}`);
});
