---
id: spec-in-two-requests
title: A spec is judged in two requests per file
date: 2026-11-08
status: accepted
components: [spec-checks]
unenforceable: "How many requests a file takes is behaviour at run time, which no import or call pattern shows."
evidence: [docs/architecture.md:219-224, commit:aa2cc1a]
---

Dated from commit aa2cc1a, which added `jevlint spec` and records it in `docs/architecture.md`.

### Context

A spec has a project checklist and many features. One request with every item would be large and
mostly irrelevant to a given file.

### Decision

The first request asks one choice question, which feature the file belongs to, together with the
project checklist. The second asks only that feature's items. Both go through `decideState`
(`docs/architecture.md:219-224`).

### Consequences

Requests stay small and relevant. A wrong route judges a file against the wrong feature.
`[spec] threshold` drops low-confidence verdicts.

### Alternatives

One request with all items, implicitly rejected by the stated reason.
