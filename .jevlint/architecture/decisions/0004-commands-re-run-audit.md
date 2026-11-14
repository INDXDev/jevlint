---
id: commands-re-run-audit
title: "`prompt`, `fix` and `explain` re-run `audit()`"
date: 2026-11-05
status: accepted
components: [commands, audit]
evidence: [docs/architecture.md:195-196, commit:e5d06f4]
---

Dated from commit e5d06f4, the initial release, whose `docs/architecture.md` first records it.

### Context

These commands need the latest findings for chosen files.

### Decision

Re-run `audit()` rather than read a stored report (`docs/architecture.md:195-196`).

### Consequences

No stale state and no report store. The cache makes repeat runs cheap, but a run with `--no-cache`
pays twice.

### Alternatives

A saved report file, rejected for staleness.
