# Family Wilma

Family Wilma is a small self-hosted app for one household. It combines messages from several Wilma accounts into one view, uses Claude Sonnet to pull out calendar-worthy information, highlights messages that contain important non-calendar content, and syncs dated items to Google Calendar.

The normal daily-use screen intentionally has only two primary actions:

- **Näytä viimeiset 30 päivää**
- **Synkkaa kalenteriin**

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
GOOGLE_CALENDAR_ID=primary
GOOGLE_ALLOWED_EMAIL=you@example.com
APP_BASE_URL=https://family-wilma.example.com
```

Google OAuth signs into the app and grants Calendar access in the same consent flow. Only
`GOOGLE_ALLOWED_EMAIL` may sign in. Sessions are revocable, stored as hashed opaque tokens
in SQLite, and remain valid for one year after their most recent use. Sign out from
**Asetukset**.

Family Wilma puts a stable source id and `family-wilma-v1` ownership marker in each event's private `extendedProperties`. Repeated syncs update the existing managed event instead of creating duplicates, and events not created by Family Wilma are never modified.

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

Wilma message bodies, grades, attendance, etc. are not archived locally.

## Calendar inputs

V1 syncs two kinds of source data:

1. structured Wilma exams from `wilma-client`
2. calendar items Sonnet extracts from current Wilma messages

Each sync fetches fresh Wilma data from the last 30 days. It includes only Sonnet results that
were previously requested explicitly and have reached the local cache. It does not analyze
missing results. A one-time historical backfill is intentionally outside the v1 application
workflow and can be handled manually.

## Privacy and logs

Secrets remain server-side. The application never intentionally logs Wilma credentials, message bodies, child data, Google tokens, or prompts containing private Wilma content. Request failures log only the error class name and return a generic browser error page.
