---
title: Risks and debt
evidence: [AGENTS.md, src/types.ts:1, src/report.ts:1-14, src/spec/run.ts:3, src/decision/decide.ts:10, src/audit.ts:38, commit:a329fd9, src/architecture/check.ts:6, src/fixtures.ts:6, src/decision/decide.ts:17-18, src/decision/decide.ts:163-164, src/commands/shared.ts:1-17, src/commands/preset.ts:2-3, docs/architecture.md:64-70, docs/architecture-reference.md:258-267, commit:94cda93, commit:d7fb1fc]
---

This chapter draws on the static facts at `a329fd9`. `jevlint architecture plan` could not be run
while this document was written, so its ranking is not included. Run it to rank these items by
severity, churn and fan-in.

### Hubs

- **`src/types.ts` is the most depended-on file.** It has 998 lines and PageRank 0.29, and 11
  candidates use it. It also changed together with `cli` in 5 commits with no import between them.
  Any change to a report shape is a public JSON change (`src/types.ts:1`). This suggests that new
  report fields often come with new flags, but the commits do not say so.
- **Configuration is the second hub.** In the facts, `config.ts` and its neighbours are used by 11
  candidates, with churn 35. Every new setting changes the schema, the defaults, the docs and,
  often, `USER_ONLY_KEYS`.
- **Commands carry the most churn (60).** `src/commands/shared.ts` holds the audit flow, agent
  preparation, flag parsing and notices. Thin commands depend on it staying focused.

### Sideways and upward coupling

- **Pipelines import each other.** `spec-checks` takes `PROVIDER_ERROR` from `src/audit.ts`
  (`src/spec/run.ts:3`). `architecture-verbs` reads the baseline from `change-review`
  (`src/architecture/check.ts:6`). Same-layer imports are allowed, but they bind release cycles
  together. Moving `PROVIDER_ERROR` into `decision` would cut the first one, since it is defined
  there and only re-exported by audit.
- **A pipeline reads engine data from another subsystem.** `preset-fixtures` imports
  `ARCHITECTURE_PRESETS` from `src/architecture/questions.ts` (`src/fixtures.ts:6`).
- **`reports` imports types from pipelines.** `src/report.ts:4-5` imports `AuditPlan` and
  `FixtureReport` from `audit.ts` and `fixtures.ts`, not from `contracts`. The rules allow it, but a
  formatter now changes when a pipeline's internal type does.
- **`report.ts` is pinned at 76.** Its pin says "splitting table, explain and plan output is the
  real fix" (`src/report.ts:2`). That split is recorded debt.
- **`agent.ts` outgrew itself once.** It passed 400 lines before the fixer runner moved out
  (commit 94cda93). It still launches agents, runs fixers, retries, collects changes and re-scores.

### Where the documents and this SSOT differ

`docs/architecture.md:64-70` lists modules per layer. This SSOT follows it, with two differences:
`src/architecture/workspace.ts` is in `code-facts` (engines), because it serves import resolution,
and `src/architecture/load.ts` joins `src/spec/load.ts` in `ssot-loading`. That table also lists
`prompt.ts` and `review.ts` twice without their directories.

### Blind spots of the checks

- **`src/credentials.ts` is always excluded from the facts**, because its name contains
  `credentials` (`docs/architecture-reference.md:263-265`). It is mapped to `configuration` by
  hand, but `check` cannot see its imports, so the rules do not cover key handling.
- **Calls outside the import graph** are invisible: spawned agents and fixers, `gh`, the bucket
  over `fetch`. The views draw them dashed. Checklist items cover the parts that matter.
- **`commands/preset.ts` imports `writeFile`** (`src/commands/preset.ts:3`) to edit a preset in a
  temp directory. This is a plausible exception to `atomic-writes`, which a model judges, so the
  checklist may flag it.
- **Global side effects.** Importing `src/decision/decide.ts` turns off AI SDK warnings for the
  whole process (`src/decision/decide.ts:18`), and the in-flight map (`src/decision/decide.ts:164`)
  is shared module state that a long-lived library caller keeps.

### Thin test coverage by name

`test/` names a file after most modules. No test file is named after `src/architecture/views.ts`,
`drift.ts`, `compile.ts`, `show.ts`, `questions.ts`, `extract.ts`, `structure.ts`, `outline.ts`,
`src/spec/run.ts` or `src/ast/languages.ts`. They may be covered through `test/architecture*.test.ts`
and `test/spec-*.test.ts`. That is not confirmed here. `views.ts` and the chapter support are the
newest code (commit a329fd9 is marked "wip").

### Complexity kept in check by jevlint itself

Several files carry `jevlint-score` pins, and refactors such as commit d7fb1fc split functions to
clear jevlint's own findings. Pins record a human's decision. Do not add one to raise a score
(`AGENTS.md`).
