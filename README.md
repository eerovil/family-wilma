# Family Wilma

Family Wilma is a small self-hosted app for one household. It combines messages from several Wilma accounts into one view, uses Claude Sonnet to pull out calendar-worthy information, highlights messages that contain important non-calendar content, and syncs dated items to Google Calendar.

The normal daily-use screen intentionally has only two primary actions:

- **Näytä kaikki viestit**
- **Synkkaa kalenteriin**

There is no multi-household tenancy, queue, Redis, background worker, or permanent Wilma-content archive.

## Requirements

- Node.js 22.5+ or Docker
- one or more Wilma logins
- an Anthropic API key
- a Google Cloud OAuth web application with Calendar API enabled

## Configuration

Copy `.env.example` to `.env`.

### Wilma accounts and children

`WILMA_ACCOUNTS_JSON` is a JSON array. Keep the three concepts separate:

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
    "password": "...",
    "profiles": [
      { "studentNumber": "12345", "child": "Aino" },
      { "studentNumber": "12346", "child": "Eero" }
    ]
  },
  {
    "id": "paivakoti",
    "baseUrl": "https://toinen.inschool.fi",
    "username": "huoltaja2",
    "password": "...",
    "profiles": [
      { "studentNumber": "8877", "child": "Aino" }
    ]
  }
]
```

The same child can therefore appear in more than one Wilma environment. The **Asetukset** page has a profile-discovery link for each configured account so the student numbers can be checked against Wilma.

Family Wilma uses `@wilm-ai/wilma-client` directly. It only performs the client's read operations for messages/exams; it does not call a mark-read endpoint. Message details have to be fetched for analysis, so if a particular Wilma deployment itself treats opening a message detail as “read”, that server-side behaviour is outside Family Wilma's control and should be verified before relying on unread state.

If Wilma asks for MFA, the request pauses with an MFA form. The submitted one-time code is held only in process memory and consumed by the next login attempt; MFA codes and Wilma cookies are not written to disk.

### Anthropic

Set `ANTHROPIC_API_KEY`. The Sonnet model is intentionally a code constant in `src/analysis.ts`, not an environment override.

Each message analysis is cached in SQLite by account + student + message id + SHA-256 of relevant message content + analyzer version. An unchanged message is therefore not sent to Sonnet again just because the page is opened or calendar sync is pressed.

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
APP_BASE_URL=https://family-wilma.example.com
```

Then open **Asetukset → Yhdistä Google Calendar** once.

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

The health endpoint is `GET /healthz`.

## Docker Compose

```sh
cp .env.example .env
# edit .env
docker compose up --build -d
```

The compose file binds port 3000 to localhost only. Put a private reverse proxy/VPN in front if remote access is needed. The app has no user account system of its own, and anybody who can reach it can see household data.

The named volume stores only:

- `family-wilma.sqlite` — Sonnet analysis cache
- `google-oauth-token.json` — Google OAuth token, mode 0600

Wilma message bodies, grades, attendance, etc. are not archived locally.

## Calendar inputs

V1 syncs two kinds of source data:

1. structured Wilma exams from `wilma-client`
2. calendar items Sonnet extracts from current Wilma messages

Each sync fetches fresh Wilma data. Cached Sonnet results are reused for unchanged messages.

## Privacy and logs

Secrets remain server-side. The application never intentionally logs Wilma credentials, message bodies, child data, Google tokens, or prompts containing private Wilma content. Request failures log only the error class name and return a generic browser error page.
