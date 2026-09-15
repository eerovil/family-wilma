# Family Wilma

Family Wilma is a small self-hosted app for one household. It combines messages from several Wilma accounts into one view, uses Claude Sonnet to pull out calendar-worthy information, highlights messages that contain important non-calendar content, and syncs dated items to Google Calendar.

The normal daily-use screen intentionally has three primary actions:

- **Kotitehtävät**
- **Näytä viimeiset 30 päivää**
- **Synkkaa kalenteriin**

**Kotitehtävät** reads each discovered child's Wilma overview and presents one combined
chronological list, newest first. Nothing is grouped. The card at the top
also reads Einari's latest dated homework block from the configured public Peda.net class page.
If that page contains alternatives for different groups, they are shown verbatim rather than
guessed. A Peda.net failure affects only that card; Wilma homework remains available.

The latest successful Wilma and Peda.net homework responses are stored in the private SQLite
database. Opening the view renders that snapshot immediately and always starts one coalesced
background refresh. The page updates when the refresh finishes; a failed refresh keeps the last
successful snapshot visible with its saved timestamp. Changing the configured Wilma household
or Peda.net source invalidates the corresponding snapshot.

Recent messages load through one in-process background job so a large inbox cannot hold the
browser request open. Opening the message list only reads Wilma: it never starts AI analysis.
Repeated clicks reuse the running fetch instead of starting duplicate Wilma requests.

Messages older than 30 days are not downloaded during normal use. After the recent view is
ready, **Hae myös vanhemmat viestit** explicitly starts a background fetch of the whole inbox,
still without analysis. There is no multi-household tenancy, Redis, external worker, or permanent
Wilma-content archive.

## Requirements

- Node.js 22.5+ or Docker
- one or more Wilma logins
- an Anthropic API key
- a Google Cloud OAuth web application with Calendar API enabled

## Configuration

Copy `.env.example` to `.env`.

### Wilma accounts and children

`WILMA_ACCOUNTS_JSON` is a JSON array. Family Wilma discovers every student/profile
available to each account and uses the name reported by Wilma as the child name:

```text
wilma account -> Wilma student/profile -> household child
```

Example:

```json
[
  {
    "id": "koulu-a",
    "baseUrl": "https://esimerkki.inschool.fi",
    "username": "huoltaja",
    "password": "..."
  },
  {
    "id": "paivakoti",
    "baseUrl": "https://toinen.inschool.fi",
    "username": "huoltaja2",
    "password": "..."
  }
]
```

The same child can therefore appear in more than one Wilma environment. No student
numbers need to be configured manually. The **Asetukset** page shows the profiles
discovered for each account.

An optional `profiles` array can override a displayed child name. It does not limit which
profiles are fetched; all profiles discovered from Wilma are included:

```json
"profiles": [{ "studentNumber": "12345", "child": "Preferred name" }]
```

Family Wilma uses `@wilm-ai/wilma-client` directly. It only performs the client's read operations for messages/exams; it does not call a mark-read endpoint. Message details have to be fetched for analysis, so if a particular Wilma deployment itself treats opening a message detail as “read”, that server-side behaviour is outside Family Wilma's control and should be verified before relying on unread state.

If Wilma asks for MFA, the request pauses with an MFA form. The submitted one-time code is held only in process memory and consumed by the next login attempt; MFA codes and Wilma cookies are not written to disk.

### Anthropic

Set `ANTHROPIC_API_KEY`. The Sonnet model is intentionally a code constant in `src/analysis.ts`, not an environment override.

Analysis is always explicit. Select one or more fetched messages and press **Analysoi valitut
batchina**. Family Wilma submits the selection through Anthropic's Message Batches API, whose
requests are priced at 50% of the normal API rates. A batch runs asynchronously and can take up
to 24 hours; its persisted status is refreshed when the message page is opened. Opening the page,
fetching older messages, and calendar sync never submit analysis requests.

Each result is cached in SQLite by account + student + message id + SHA-256 of relevant message
content + analyzer version. An unchanged or already-pending message is therefore not submitted
again. Batch bookkeeping stores these identities and provider request ids, but not Wilma message
bodies.

For agent-operated local development, set `ANALYSIS_MODE=manual` and leave
`ANTHROPIC_API_KEY` empty. The same selection button then writes a private request under
`DATA_DIR/manual-analysis` instead of contacting Anthropic. Request files are mode 0600 and
contain only explicitly selected messages. An operator or coding agent can process them with:

```sh
npm run manual-analysis -- pending
npm run manual-analysis -- export manual-<id> /private/path/request.json
npm run manual-analysis -- import manual-<id> /path/to/results.json
```

The import file uses `{ "version": 1, "batchId": "manual-<id>", "results": [...] }`; every
result has the request's `customId` and an `analysis` object in the documented format below.
Imports must be complete and valid. After a successful import, the request containing the
message text is deleted and only the normal SQLite analysis cache remains.

The cached structured result is split into:

```json
{
  "calendarItems": [],
  "hasOtherContent": true
}
```

`calendarItems` feeds calendar sync. `hasOtherContent` drives highlighting. The prompt and parser are deliberately conservative: uncertainty means highlight, not hide.

### Google Calendar

Create an OAuth 2.0 **Web application** in Google Cloud, enable Google Calendar API, and configure this redirect URI:

```text
${APP_BASE_URL}/oauth/google/callback
```

Set:

```text
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_ALLOWED_EMAIL=you@example.com
APP_BASE_URL=https://family-wilma.example.com
```

Optional server-side error reporting uses `SENTRY_DSN`, with
`SENTRY_ENVIRONMENT=production` and an optional `SENTRY_RELEASE`. Family Wilma sends only
fixed error categories, stack frames, safe status/code metadata, and fixed operation tags: request data, cookies, user identity,
breadcrumbs, local variables, and performance traces are disabled.

Google OAuth signs into the app and grants permission to create and manage calendars owned by
Family Wilma in the same consent flow. It does not grant access to unrelated calendars. Only
`GOOGLE_ALLOWED_EMAIL` may sign in. Sessions are revocable, stored as hashed opaque tokens
in SQLite, and remain valid for one year after their most recent use. Sign out from
**Asetukset**.

After upgrading from the earlier single-calendar version, reconnect Google Calendar once so
Google can grant the narrower managed-calendar permission.

The first sync creates **Family Wilma – yhteiset** and one **[Child] – Lukujärjestys**
calendar for every discovered child. Their ids are remembered locally. Family Wilma puts a
stable source id and `family-wilma-v1` ownership marker in each event's private
`extendedProperties`. Repeated syncs update existing managed events instead of creating
duplicates, and events not created by Family Wilma are never modified.

## Run locally

```sh
cp .env.example .env
npm install
npm test
npm start
```

For development:

```sh
npm run dev
```

The bare Node process binds to `HOST=127.0.0.1` by default. Docker Compose overrides this
inside the container while publishing only to the host's loopback interface.

The health endpoint is `GET /healthz`.

## Docker Compose

```sh
cp .env.example .env
# edit .env
docker compose up --build -d
```

The compose file binds `HOST_PORT` (3000 by default) to localhost only. Put an HTTPS
reverse proxy in front for remote access. Application pages require the Google account in
`GOOGLE_ALLOWED_EMAIL`; the health endpoint remains public for monitoring.

The named volume stores only:

- `family-wilma.sqlite` — Sonnet analysis cache and batch status/mapping metadata
- `google-oauth-token.json` — Google OAuth token, mode 0600
- `google-calendar-map.json` — ids of the secondary calendars created by Family Wilma, mode 0600

Wilma message bodies, grades, attendance, etc. are not archived locally.

## Calendar inputs

V1 syncs three kinds of source data:

1. six months of Wilma lessons into each child's **Lukujärjestys** calendar
2. structured Wilma exams into **Family Wilma – yhteiset**
3. calendar items Sonnet extracts from current Wilma messages into **Family Wilma – yhteiset**

Each sync fetches lessons from the current week through six months ahead. Future managed lessons
that have disappeared from Wilma are removed from the child calendar; other calendar events are
untouched. Removal is skipped if Wilma returns no valid timetable or malformed lesson data, so
an ambiguous upstream response cannot empty a child calendar. The shared calendar includes only Sonnet results that were previously requested
explicitly and have reached the local cache. Sync never analyzes missing results. A one-time
historical backfill is intentionally outside the v1 application workflow and can be handled
manually.

Calendar sync runs as an in-process background job. The start request returns immediately, the
home page refreshes while the job is running, and closing the browser does not cancel it. The
latest completion counts or a retryable error remain visible on the home page. An application
restart interrupts an active sync; it is never retried automatically because an interrupted
Google write can have an uncertain result.

## Privacy and logs

Secrets remain server-side. The application never intentionally logs Wilma credentials, message
bodies, child data, Google tokens, or prompts containing private Wilma content. Manual localdev
analysis is the explicit exception to body persistence: selected messages remain in its private
queue until a successful import. Request failures log only a fixed error category and return a
generic browser error page.
