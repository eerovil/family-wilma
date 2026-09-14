# family-wilma

A small self-hosted app that pulls the family's Wilma messages into one place, and pushes
the dated bits into Google Calendar.

One deployment serves one household. There is no multi-tenant mode and none is planned.

> **Status: scaffolding only.** Nothing here is implemented yet. This repository currently
> holds the intended direction, the domain model, and the questions that still need answering.
> See [docs/open-questions.md](docs/open-questions.md) for what is deliberately undecided.

## The problem

Finnish schools and daycares talk to parents through Wilma. A household with children in
several schools ends up with several Wilma logins, each with its own inbox, and the same
"remember the field trip on Tuesday" note buried somewhere in one of them.

## What it will do

Two buttons, and not much else:

1. **Näytä kaikki viestit** — every configured Wilma's messages in one timeline, newest first.
   Messages that say something beyond a date are highlighted, so a message that just announces
   a calendar event does not need reading twice.
2. **Synkkaa kalenteriin** — pull the dated items out of those messages and put them in Google
   Calendar.

The reading and the highlighting are done by Claude Sonnet, server-side. Each message is sent
once; the result is cached so re-opening the page does not re-analyse anything. See
[docs/llm-cache.md](docs/llm-cache.md).

## What it will not do

- Archive or back up Wilma content. Wilma is the source of truth; if a message is gone from
  Wilma, it is gone from here too.
- Serve more than one household per deployment.
- Run a queue, a background worker, a Redis, or a Cloudflare Worker. See
  [docs/architecture.md](docs/architecture.md) for the full list of things left out on purpose.

## Shape

One Node.js/TypeScript process, self-hosted on a VPS or a home server, ideally through Docker
Compose. It talks to three things: Wilma (via
[`@wilm-ai/wilma-client`](https://www.npmjs.com/package/@wilm-ai/wilma-client)), the Anthropic
API (via `@anthropic-ai/sdk`), and the Google Calendar API. The only thing it writes to disk is
a small SQLite file holding the analysis cache.

## Documentation

| Document | What is in it |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | The V1 shape, and everything deliberately left out |
| [docs/domain.md](docs/domain.md) | Accounts, students and children — and why they are three things |
| [docs/llm-cache.md](docs/llm-cache.md) | The cache key, and the shape of what Sonnet returns |
| [docs/security.md](docs/security.md) | What must never be logged or stored |
| [docs/open-questions.md](docs/open-questions.md) | What is still unknown, and must be answered before building |

## Getting started

`npm install && npm run build && npm start` works on Node 22, and `docker compose up` builds
and runs — but the entry point is a placeholder that prints a message and exits. There is no
application behind it yet.

When there is, running it will be:

```sh
cp .env.example .env   # fill in the Wilma logins, the Anthropic key, the Google credentials
docker compose up
```
