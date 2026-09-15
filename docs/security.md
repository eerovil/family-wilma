# Security and privacy

This app handles school messages about children, and the credentials that reach them. It is a
single-household self-hosted app, so the rules are short — but they are not optional.

## Never log

**Wilma credentials.** No username, no password, no session cookie, no login form field — not
at debug level, not in an error message, not in a stack trace. `@wilm-ai/wilma-client` takes a
`WilmaProfile` containing the password as a plain field, so anything that dumps a profile object
wholesale leaks it. Log the `baseUrl` if you need to know which account failed; never the
profile.

Note the client's own `debug` flag on `WilmaProfile` and `WilmaSession` — leave it off outside
local debugging, and check what it prints before turning it on.

**Message bodies and child data.** No subjects, no bodies, no student names, no student numbers
in logs. When something fails while processing a message, log the account and the message ID —
enough to find it again in Wilma, and nothing that reveals what it said.

**Secrets of any kind.** The Anthropic API key, the Google OAuth client secret, the refresh
token. Same rule.

## Keep server-side

Every secret stays in the server process. No API key, no OAuth secret, and no Wilma credential
is ever sent to the browser or embedded in a page. The browser talks only to this app; this app
talks to Wilma, Anthropic and Google.

This is the reason the Anthropic SDK is called from the server rather than the client, and it is
not negotiable even though the deployment is a private box.

## Persist as little as possible

Three Wilma-derived datasets are written to disk: the [analysis cache](llm-cache.md), one
replaceable 30-day message snapshot, and one replaceable homework snapshot. The snapshots avoid
making the family wait for Wilma again after routine application restarts.

Two consequences worth being deliberate about:

- The cache key contains a hash of message content, not the content itself. Keep it that way.
- Whether the *analysis output* is safe to store is a real question, since `calendarItems` will
  contain dates and event titles taken from messages about specific children. It is stored
  because the app cannot work otherwise — but that is the ceiling, not a licence to store more.
- The homework snapshot contains child names, student numbers, subjects, teachers, and raw
  homework text. It is kept only in the mode-0600 household SQLite file, replaced after each
  successful refresh, and never logged or sent to Sentry.
- The message snapshot contains the raw bodies of messages from the last 30 days. It has the same
  mode-0600 and no-logging restrictions and is replaced after each successful refresh; it is not
  a historical archive.

Anything that would retain message bodies beyond that bounded snapshot — a search index, a local
archive, or a debug dump — needs a much better reason than convenience.

## Trusted-device PWA cache

An installed browser may store successful authenticated GET pages, including rendered messages
and homework, in its Cache Storage for offline use. This is an explicit trusted-device tradeoff:
OAuth routes, redirects, and every non-GET action are excluded, but signing out does not erase
the device's offline page cache. Clear the site's stored data before sharing or retiring a device.

## Authentication and network boundary

One deployment still serves one household, with no roles or admin panel. Every application page
and action requires Google sign-in, and only the verified account configured in
`GOOGLE_ALLOWED_EMAIL` may sign in. The public health endpoint contains no household data.

Sessions are random opaque values stored only as SHA-256 hashes in SQLite. They expire one year
after their most recent use and can be revoked by signing out. In production, cookies are
host-only, Secure, HTTP-only and SameSite restricted. Google OAuth attempts are bound to the
browser that started them, expire after ten minutes, and can be used only once. Run the app
behind HTTPS.
