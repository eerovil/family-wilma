# Architecture

The V1 target is deliberately small: one process, three outbound integrations, one small
database file. Anything that would make it bigger needs a concrete reason first.

## The pieces

```
                    ┌──────────────────────────────┐
   browser ────────▶│  family-wilma (one process)  │
                    │                              │
                    │  ┌────────────────────────┐  │
                    │  │ Wilma reader           │──┼──▶ Wilma instances
                    │  │ (@wilm-ai/wilma-client)│  │    (one login per account)
                    │  └────────────────────────┘  │
                    │  ┌────────────────────────┐  │
                    │  │ Analyzer               │──┼──▶ Anthropic API
                    │  │ (@anthropic-ai/sdk)    │  │    (claude-sonnet-5)
                    │  └────────────────────────┘  │
                    │  ┌────────────────────────┐  │
                    │  │ Calendar sync          │──┼──▶ Google Calendar API
                    │  └────────────────────────┘  │
                    │  ┌────────────────────────┐  │
                    │  │ Analysis + homework    │──┼──▶ SQLite file
                    │  │ cache                  │  │
                    │  └────────────────────────┘  │
                    └──────────────────────────────┘
```

## Runtime

**Node.js / TypeScript, one process.** Everything runs in the same process: serving the page,
fetching from Wilma, calling Sonnet, and writing to Google Calendar. Message loading, homework
refresh, and calendar sync are coalesced in-process background jobs so browser requests return
promptly. Their active state is intentionally not durable; only data that must survive restart is.

**Self-hosted via Docker Compose.** One service, one mounted volume for the SQLite file. The
target is a VPS or a home server, not a managed platform.

**Installable browser shell.** The server publishes an origin-bound manifest, icons, and one
root-scoped service worker. Navigations remain network-first. Successful authenticated GET pages
are stored in that browser for exact-page offline use; OAuth routes and writes bypass the cache.
PWA assets use a content-derived cache generation so a changed shell replaces its predecessor.

## Storage

**A small SQLite file holds the analysis cache and the latest successful homework snapshot.**
Homework can be re-derived, but retaining one snapshot avoids forcing a slow Wilma refetch after
every application restart. Cache rows are scoped by configuration fingerprints so a changed
household or class-page source cannot display the previous source's data.

**Fetched Wilma messages live in memory only.** Messages, students, and folders are held for the
life of the process (or shorter) and re-fetched afterwards. Homework is the deliberate exception:
one latest successful response per source is stored and replaced atomically after refresh.

## Outbound integrations

**Wilma — `@wilm-ai/wilma-client`.** One `WilmaClient` per account, logged in with a
`WilmaProfile` (`baseUrl`, `username`, `password`, and the `studentNumber` selecting which
student's view to read). `WilmaClient.listStudents(profile)` enumerates the students a login can
see; `client.messages.list(folder)` and `client.messages.get(id)` read the inbox. Login can
demand a second factor — see [open questions](open-questions.md).

**Anthropic — `@anthropic-ai/sdk`, model `claude-sonnet-5`.** Called server-side only; the API
key never reaches the browser. This follows the same shape as
[`eerovil/ruokalista`](https://github.com/eerovil/ruokalista) — server-side SDK call, key from
the environment — but not its Cloudflare Worker hosting, which this project rules out.

The analyzer needs a fixed output shape, so it should use structured outputs
(`output_config.format` with a JSON schema, or the SDK's `messages.parse()` helper) rather than
asking for JSON in the prompt and hoping. The exact schema is
[an open question](open-questions.md).

**Google Calendar.** OAuth uses the narrow `calendar.app.created` scope. The calendar module
creates one shared calendar plus one lesson calendar per displayed child, remembers their ids,
routes events, and reconciles the six-month lesson window behind one sync interface.

## Deliberately left out

Each of these is a real option that is being declined, not an oversight:

| Not doing | Why |
| --- | --- |
| Redis | Nothing to share between processes; there is one process |
| A durable queue | Background jobs are coalesced in one process; active work may restart safely |
| A background worker | Add one only when there is a concrete job that cannot run in a request |
| A backup subsystem | Wilma is the source of truth; there is nothing here worth backing up |
| Cloudflare Workers / D1 | This is a self-hosted box, not an edge deployment |
| Multi-tenant / admin UI | One deployment, one household. Tenancy is the thing that makes small apps big |
| A Wilma data archive | The homework cache is one replaceable snapshot, not a historical archive |
