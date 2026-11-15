---
id: agent-writes-the-ssot
title: A coding agent writes the SSOT; jevlint decides its rules statically
date: 2026-11-12
status: accepted
components: [architecture-verbs, ssot-loading, ssot-conformance]
unenforceable: "That jevlint never writes the SSOT is the absence of a write, which no rule over imports or calls can prove."
evidence: [docs/architecture-driven-development.md:21-25, docs/architecture-driven-development.md:128, docs/security.md, src/decision/providers.ts:9, commit:5f1db8a, commit:aa2cc1a]
---

Dated from commit 5f1db8a, which added the architecture SSOT.

### Context

Naming components and explaining them needs judgement. Checking imports against them does not.

### Decision

`architecture compile` collects static facts and a draft, and prints a prompt for a coding agent,
which writes `.jevlint/architecture/` (commit 5f1db8a). `check --static`, `list`, `show` and `plan`
decide everything from the AST with no network. The model judges only prose checklist items and
stale summaries. `spec compile` was built the same way earlier (commit aa2cc1a,
`docs/architecture.md:223-224`).

### Consequences

The SSOT is reviewable YAML that people own. CI can gate structure at no cost, and the prompt
carries paths and names, never file contents.

### Why an agent, not a model call from jevlint

Recorded in issue #15 ("the division of work follows what each part can do well") and
`docs/architecture-driven-development.md:21-25`, `:128`:

- jevlint's only model is a decision model (`src/decision/providers.ts:9`): it answers fixed
  questions with a score, a probability or a choice, cached by content. It cannot open files or
  write prose, and writing the SSOT means reading many files the facts point at, on demand.
- An agent writes into the working tree, so a person reviews the diff and commits it, as with code.
  jevlint itself writes only `.jevlint/baseline.json` and the `--html` target (`docs/security.md`),
  and keeps that boundary.
- The user picks the agent and pays through its own login (`--agent`, `--agent-login`), or pastes
  the prompt anywhere (`--copy`). jevlint holds no key for a generative model.
- What an agent writes is then checked by what jevlint does well: arrows against imports, citations
  against files, rules against the AST.

### Alternatives

jevlint calling a generative model and writing the SSOT itself. Rejected for the reasons above: it
would need a second kind of provider and key, write repository files with no review, and lose the
agent's ability to read the code it describes.
