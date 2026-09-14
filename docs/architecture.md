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
                    │  │ Analysis cache         │──┼──▶ SQLite file
                    │  └────────────────────────┘  │
                    └──────────────────────────────┘
```

## Runtime

**Node.js / TypeScript, one process.** Everything runs in the same process: serving the page,
fetching from Wilma, calling Sonnet, writing to Google Calendar. Both user actions are things a
person clicks and waits for, so there is nothing that needs to outlive a request.

**Self-hosted via Docker Compose.** One service, one mounted volume for the SQLite file. The
target is a VPS or a home server, not a managed platform.

## Storage

**A small SQLite file, holding the analysis cache and nothing else.** Adding a table means
deciding that some state genuinely cannot be re-derived from Wilma — see
[open questions](open-questions.md) for what the schema will need to look like.

**Fetched Wilma data lives in memory only.** Messages, students, and folders are held for the
life of the process (or shorter) and re-fetched afterwards. A restart costs a refetch, which is
the right trade for not keeping children's messages on disk.

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

**Google Calendar.** OAuth against the household's own Google account, then write events. The
hard part is not writing the event but writing it *once* — see
[open questions](open-questions.md).

## Deliberately left out

Each of these is a real option that is being declined, not an oversight:

| Not doing | Why |
| --- | --- |
| Redis | Nothing to share between processes; there is one process |
| A queue | Both actions are click-and-wait; nothing needs to survive a restart |
| A background worker | Add one only when there is a concrete job that cannot run in a request |
| A backup subsystem | Wilma is the source of truth; there is nothing here worth backing up |
| Cloudflare Workers / D1 | This is a self-hosted box, not an edge deployment |
| Multi-tenant / admin UI | One deployment, one household. Tenancy is the thing that makes small apps big |
| A Wilma data archive | Same reason as backups, plus it means storing children's messages on disk |
