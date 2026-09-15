# The analysis cache

Every Wilma message gets read once by Claude Sonnet. The result is kept so that opening the page
again, or syncing the calendar again, costs nothing.

This cache is the only thing this app persists. Everything else is re-fetched from Wilma.

## The key

```
wilma_account_id + message_id + sha256(relevant_content) + analyzer_version
```

Four parts, each earning its place:

**`wilma_account_id`** — message IDs are only unique within one Wilma instance. In
`@wilm-ai/wilma-client` a message carries `wilmaId`, a number scoped to the instance it came
from, so two accounts will collide without this.

**`message_id`** — the message's own `wilmaId`.

**`sha256(relevant_content)`** — a hash of the parts of the message that actually change the
answer, so that an edited message or a new reply in a thread produces a new key and gets read
again. What exactly goes into the hash is [an open question](open-questions.md): subject and
body clearly, thread replies probably, but `fetchedAt` must not, or nothing would ever hit the
cache.

**`analyzer_version`** — bumped by hand when the prompt or the output schema changes. Without
it, improving the prompt would silently keep serving answers from the old one.

Note what is *not* in the key: the child. A child-level key breaks the moment two students map
to the same child, and the analysis does not depend on who the message is about. See
[the domain notes](domain.md).

## What Sonnet returns

Roughly:

```json
{
  "calendarItems": [],
  "hasOtherContent": true
}
```

- **`calendarItems`** — the dated things in the message. This is what **Analysoi kaikki ja synkkaa kalenteri**
  turns into Google Calendar events. The per-item shape (title, date, time, location, which
  child) is [not settled yet](open-questions.md).
- **`hasOtherContent`** — true when the message says something beyond the dates. This drives the
  highlight in **Näytä kaikki viestit**: a message that is *only* an event announcement has
  already been fully absorbed by the calendar sync and does not need reading; a message that
  also asks for a permission slip does.

The analyzer should ask for this shape with structured outputs (`output_config.format` with a
JSON schema, or the SDK's `messages.parse()`), not by describing the JSON in the prompt. The
exact schema is an open question, but the mechanism is not.

## Lifetime

Entries can be deleted at any time — the only cost is re-analysing that message. Which means
there is no backup story here, and no migration story either: if the schema changes awkwardly,
dropping the table is a valid answer.
