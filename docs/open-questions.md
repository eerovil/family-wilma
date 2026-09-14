# Open questions

These are unanswered on purpose. Each one would otherwise be answered by a guess, and a guess
baked into scaffolding is harder to remove than a gap.

Answer them by checking the real thing — a real Wilma login, a real calendar, a real message —
not by reasoning about what is likely.

## 1. Wilma MFA and session persistence

`@wilm-ai/wilma-client` has a `MfaRequiredError` and takes an `MfaCallback`
(`(formkey: string) => Promise<string>`) on both `WilmaClient.login()` and
`WilmaClient.listStudents()`. So a second factor is clearly possible. Unknown:

- Do the household's actual Wilma instances demand it, and if so, on every login or only
  sometimes?
- A `WilmaClient` holds its session in memory. If the answer to the above is "every login",
  a restart means a human has to type a code before anything works — which would be a real
  constraint on the "one process, restart freely" design.
- The public API exposes no way to save or restore a session. Is there a supported way to keep
  one alive across restarts, or does keeping the process up become load-bearing?

**Answer by:** logging in against the real instances and watching what happens, including after
a restart and after leaving it idle for a day.

## 2. Google Calendar event identity

Writing an event is easy. Writing it exactly once, across repeated syncs, is the actual problem.
Pressing **Synkkaa kalenteriin** twice must not produce two identical events, and a re-analysed
message whose date moved must move the event rather than add a second one.

Unknown:

- What identifies an event as "the one this calendar item already created"? A deterministic
  event ID derived from the cache key is one option; a private extended property holding it is
  another. Both need checking against what the API actually allows — ID format rules, whether a
  deleted-then-recreated ID can be reused.
- What happens when a human edits or moves the event by hand? Does the next sync stomp it?
- One calendar for the household, or one per child? The domain model allows either.

**Answer by:** reading the Calendar API docs on event IDs and extended properties, then trying
a double sync against a real calendar.

## 3. The SQLite cache schema

The [cache key](llm-cache.md) is settled in principle; the table is not.

- Does the key get stored as its four columns, or hashed into one? Four columns make debugging
  and partial invalidation ("re-analyse everything from account A") possible.
- Is the analysis stored as a JSON blob, or are `calendarItems` normalised into rows? Normalised
  rows only earn their place if the calendar sync needs to query them independently — which
  depends on question 2.
- Is anything else forced into the database? Google OAuth refresh tokens have to live somewhere.
  Student profiles are discovered from Wilma on each fetch; optional child-name overrides remain
  deployment configuration and do not need database state.

**Answer by:** settling question 2 first, since it decides whether sync state needs querying.

## 4. The Sonnet prompt and output schema

The output shape is sketched in [the cache notes](llm-cache.md) as `calendarItems` and
`hasOtherContent`. The details are not:

- What is in a `calendarItem`? Title and date at minimum. Time, end time, location, and which
  child are all plausible and all unconfirmed.
- How are vague dates handled — "next week", "the last Friday of the month", a date with no
  year? Resolved at analysis time against the message's `sentAt`, or passed through as text?
- What counts as `hasOtherContent`? A permission slip request clearly does. A greeting clearly
  does not. The boundary is a judgement call that needs real messages to calibrate.
- Finnish and Swedish messages in the same inbox. Does the prompt need to say anything about
  language, and should `calendarItems` keep the original wording or translate?

**Answer by:** collecting a set of real messages and working out what the right answer is for
each *before* writing the prompt.
