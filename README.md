# Family Wilma

Family Wilma is a small self-hosted app for one household. It combines messages from several Wilma accounts into one view, uses Claude Sonnet to pull out calendar-worthy information, highlights messages that contain important non-calendar content, and syncs dated items to Google Calendar.

The normal daily-use screen intentionally has two primary actions:

- **Kotitehtävät**
- **Näytä viimeiset 30 päivää**

**Kotitehtävät** reads each discovered child's Wilma overview and presents one combined
chronological list, newest first, under one weekday-and-date heading per day
(`ke 16.9.2026`). Only the date groups; children and subjects stay interleaved.

Many teachers write the homework into the lesson diary (Tuntipäiväkirja) instead of Wilma's
separate homework field, so the view also reads each child's per-subject group pages and shows
the last 14 days of diary entries, marked with a **Tuntipäiväkirja** pill. The diary text is
shown exactly as the teacher wrote it — topic and homework together — because splitting the two
apart reliably is not possible. Subjects whose teacher keeps no diary simply do not appear. If
the diary cannot be read, the rest of the homework is still shown and the failure is reported
through the normal error channel.

The card at the top
also reads Einari's latest dated homework block from the configured public Peda.net class page.
If that page contains alternatives for different groups, they are shown verbatim rather than
guessed. A Peda.net failure affects only that card; Wilma homework remains available.

The latest successful Wilma and Peda.net homework responses are stored in the private SQLite
database. Opening the view renders that snapshot immediately and starts one coalesced background
refresh only when a source is at least 15 minutes old. **Päivitä nyt** bypasses that freshness
window. The page updates when the refresh finishes; a failed refresh keeps the last successful
snapshot visible with its saved timestamp. Changing the configured Wilma household
or Peda.net source invalidates the corresponding snapshot.

Family Wilma is installable as a PWA. Its service worker uses the network first and stores
successful application pages on that browser for offline access. OAuth routes and all writes are
never cached. Because cached pages can contain family data, install it only on a trusted device
and remove the site's stored data when that device changes hands.

The latest successful 30-day message snapshot is stored in the private SQLite database and shown
immediately after restarts. Opening the message list refreshes it in the background only when it
is at least 15 minutes old; **Päivitä viestit** bypasses that window. Message loading never starts
AI analysis, and repeated requests reuse the running fetch. Messages older than 30 days are not
downloaded by this view. Messages with exactly the same sender, subject, and body on the same
Helsinki calendar date are shown once with every affected child. That logical message is also
analyzed only once, and its shared calendar entries carry all affected child names. There is no
multi-household tenancy, Redis, or external worker.

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

Analysis is always explicit. Press **Analysoi kaikki ja synkkaa kalenteri** on the message view.
Family Wilma submits every currently displayed, uncached logical 30-day message through Anthropic's Message Batches API, whose
requests are priced at 50% of the normal API rates. A batch runs asynchronously and can take up
to 24 hours; its persisted status is refreshed when the message page is opened. Calendar sync
starts only after those message analyses have reached a terminal state. Opening or refreshing the
page never submits analysis requests.

Each logical result is cached in SQLite by the exact sender, subject, body, Helsinki date, and
analyzer version. Existing per-child cache entries are reused and promoted when matching messages
are first merged, so this change does not trigger a second analysis charge. An unchanged or
already-pending logical message is not submitted again. Batch bookkeeping stores these identities
and provider request ids, but not Wilma message bodies.

For agent-operated local development, set `ANALYSIS_MODE=manual` and leave
`ANTHROPIC_API_KEY` empty. The same all-message button then writes a private request under
`DATA_DIR/manual-analysis` instead of contacting Anthropic. Request files are mode 0600 and
contain the displayed 30-day messages that still need analysis. An operator or coding agent can process them with:

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
GOOGLE_ALLOWED_LOGIN_EMAILS=you@example.com,partner@example.com
APP_BASE_URL=https://family-wilma.example.com
```

Optional server-side error reporting uses `SENTRY_DSN`, with
`SENTRY_ENVIRONMENT=production` and an optional `SENTRY_RELEASE`. Family Wilma sends only
fixed error categories, stack frames, safe status/code metadata, and fixed operation tags: request data, cookies, user identity,
breadcrumbs, local variables, and performance traces are disabled.

Normal Google sign-in requests identity only. `GOOGLE_ALLOWED_EMAIL` is the Calendar owner;
`GOOGLE_ALLOWED_LOGIN_EMAILS` is the comma-separated household allowlist and must include that
owner. The owner separately grants permission to create/manage Family Wilma calendars and their
sharing rules. Calendar credentials remain bound to the owner even when another household member
signs in or starts a sync. Additional allowed members receive read-only access to every managed
calendar. Sessions are revocable, stored as hashed opaque tokens in SQLite, and remain valid for
one year after their most recent use. Sign out from **Asetukset**.

After enabling household sharing, reconnect Google Calendar once so Google can grant both the
managed-calendar and calendar-sharing permissions.

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

- `family-wilma.sqlite` — latest message/homework snapshots, Sonnet analysis cache, and batch status/mapping metadata
- `google-oauth-token.json` — Google OAuth token, mode 0600
- `google-calendar-map.json` — ids of the secondary calendars created by Family Wilma, mode 0600

Only one replaceable 30-day message snapshot is retained; grades, attendance, and historical
message archives are not stored locally.

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
