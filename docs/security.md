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

The only Wilma-derived thing written to disk is the [analysis cache](llm-cache.md), and only
because sending the same message to Sonnet repeatedly would be wasteful. Everything else is held
in memory and re-fetched.

Two consequences worth being deliberate about:

- The cache key contains a hash of message content, not the content itself. Keep it that way.
- Whether the *analysis output* is safe to store is a real question, since `calendarItems` will
  contain dates and event titles taken from messages about specific children. It is stored
  because the app cannot work otherwise — but that is the ceiling, not a licence to store more.

Anything that would put message bodies on disk — a search index, a local archive, a debug dump —
needs a much better reason than convenience.

## No tenancy, no admin

One deployment, one household, no user accounts, no roles, no admin panel. Not because those
would be insecure, but because the complexity they bring is where security bugs live. If this
ever needs to serve a second household, that is a different application.

The app has no authentication of its own. **Bind it to localhost or a private network**, or put
it behind something that does authenticate. Anyone who can reach it can read the family's
messages.
