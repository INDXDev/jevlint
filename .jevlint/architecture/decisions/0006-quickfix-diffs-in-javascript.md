---
id: quickfix-diffs-in-javascript
title: "`quickfix` diffs in JavaScript, not with `git diff`"
date: 2026-11-09
status: accepted
components: [agent-handoff, repository-access]
enforced_by: [repository-access.git-helper]
evidence: [docs/architecture.md:189-193, src/git.ts:157, commit:b44cf9c]
---

Dated from commit b44cf9c, which added `quickfix` and records it in `docs/architecture.md`.

### Context

A repository's git config can make `git diff` run external diff and textconv programs
(`src/git.ts:157`).

### Decision

Git only finds which files changed. jsdiff writes git-style patches that `git apply` accepts, and
`diff-view.ts` draws them, including a built-in side-by-side view in the style of delta (commit
b44cf9c, `docs/architecture.md:189-193`).

### Consequences

No repository-chosen program runs, and a redirected run prints a plain patch. jevlint maintains its
own diff renderer.

### Alternatives

`git diff` with a pager such as delta. Rejected because it would run repository-controlled programs
on repository text.
