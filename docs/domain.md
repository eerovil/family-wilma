# Domain model

The one modelling decision that matters: **a Wilma login is not a child.** Getting this wrong
early is expensive to undo, because it leaks into the cache keys, the UI, and the calendar sync.

```
wilma_account  ──(1:n)──▶  wilma_profile / student  ──(n:1)──▶  child
```

## wilma_account

One login to one Wilma instance: a base URL, a username, a password. In
`@wilm-ai/wilma-client` terms this is the `baseUrl` + `username` + `password` of a
`WilmaProfile`.

A household typically has several, because each municipality or school runs its own Wilma and
issues its own credentials.

## wilma_profile / student

One student's view inside one account. A single login can expose several — a parent with three
children in the same school signs in once and picks between them.

The client makes this explicit: `WilmaClient.listStudents(profile)` returns a `StudentInfo[]`
(`studentNumber`, `name`, `href`), and you then log in with `studentNumber` set to read that
student's messages. So the account is the credential and the student is the selection.

## child

A real person in the household. This is the concept the app's user thinks in, and the only one
they should have to think in.

A child maps to one or more students. **The same child can appear under more than one account**
— a move between municipalities, or a school and a hobby that use different Wilma instances.
Two students in two accounts, one child.

## Why not collapse them

The tempting shortcut is "one login = one child", and it breaks in both directions:

- **One account, several children.** Collapsing means either logging in repeatedly under one
  child's name, or losing the other children entirely.
- **One child, several accounts.** Collapsing means the same child shows up twice in the UI
  with two half-complete timelines, and the calendar sync duplicates their events.

## What this means in practice

- **Configuration lists accounts.** Credentials belong to an account, never to a child.
- **Mapping is separate and explicit.** Somewhere there is a list saying "account A's student
  `12345` is Aino; account B's student `67890` is also Aino". Whether that lives in the
  environment file or in SQLite is [an open question](open-questions.md).
- **The timeline is per household, grouped by child.** Not by account, and not by student.
- **The cache is keyed by account and message, not by child.** A child-level key would break
  the moment two students map to the same child. See [the cache notes](llm-cache.md).
