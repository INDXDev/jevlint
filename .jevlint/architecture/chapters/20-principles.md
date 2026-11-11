---
title: Design principles
evidence: [AGENTS.md, CONTRIBUTING.md, docs/architecture.md:60-93, src/decision/decide.ts:17-18, src/decision/decide.ts:177-183, src/scoring.ts:1-3, src/commands/shared.ts:19-20, src/audit.ts:40-50, src/config.ts:17-19, src/git.ts:16-27, src/architecture/externals.ts:1, src/ast/languages.ts:11-15]
---

Each principle below says what it costs and what keeps it true. Rule ids refer to `index.yaml` and
the component files; a principle kept "by convention" has no automatic check.

### 1. Dependencies point down five layers

Interface → pipeline → engines → infrastructure → contracts (`docs/architecture.md:60-72`).
Commands parse flags and print; `audit()` and the other pipelines decide.

- **Why.** Pipelines and engines stay testable without a terminal, and the library API
  (`src/index.ts`) can export the pipelines directly.
- **Cost.** Work that several commands share has to live somewhere. Much of it landed in
  `src/commands/shared.ts` (`auditProject`, `prepareAgentRun`), and `commands` is the
  most-changed candidate (churn 60 in the facts).
- **Kept by** `layers-point-down`, `no-component-cycles`, the `depends_on` allowlists, and the
  `commands.thin-commands` checklist item.

### 2. Only `src/decision/` talks to a model

Every model call, whether audit questions, semantic rules, `--intent`, spec verdicts or architecture
reviews, goes through `decideFile` or `decideState` (`src/decision/decide.ts:177-196`).

- **Why.** The AI SDK's decision API is experimental, so a breaking change must stay in one folder
  (`docs/architecture.md:81-82`). One path also gives every caller the cache, retries, timeouts and
  the Cloudflare question split for free.
- **Cost.** Every new kind of question must fit the `state` + `questions` shape. Choice questions
  needed the more general `decideState`. The SDK prints warnings, so `src/decision/decide.ts:18` silences them
  globally.
- **Kept by** `ai-sdk-only-in-decision` (an `only` rule) and the `decision.cache-key` checklist item.

### 3. Scoring is pure and runs after the cache

`src/scoring.ts` holds the formulas of `docs/scoring.md` and performs no I/O. The cache stores raw
answers (`RawAnswer`), never scores.

- **Why.** Every formula is testable with plain values. Changing weights, `ast_weight` or the scale
  costs no model call (`docs/architecture.md:185`).
- **Cost.** Each report recomputes scores from raw answers, and pins must be applied in scoring
  (`modelResult`), not in the cache.
- **Kept by** `scoring.pure` (forbids `node:*` imports) and `test/scoring.test.ts`.

### 4. Core modules are silent; stdout carries only results

Only `cli` and `commands` write to the terminal. Core modules return data or throw `UserError`.
Prompts go to stderr through `PROMPT_IO` (`src/commands/shared.ts:19-20`).

- **Why.** `--json` and piped prompts stay parseable, and the library API prints nothing
  (`src/index.ts:1`).
- **Cost.** Progress has to come back through callbacks such as `AuditOptions.onProgress`
  (`src/audit.ts:49`), and every formatter returns a string for a command to print.
- **Kept by** `terminal-only-interface` (a `forbid-call` on `console.$M($$$)`) and the
  `stdout-results-only` checklist item.

### 5. The audited repository is hostile

Every path, config, preset and commit message in it may be crafted (`AGENTS.md`).

- **Why.** jevlint holds API keys, runs git, and can start an agent. A repository must not be able
  to redirect a key, run a program, or drive the terminal.
- **Cost.** It needs a stricter repository config schema (`USER_ONLY_KEYS`, `src/config.ts:19`), a
  hardened `git()` helper and plumbing instead of `git diff` (`src/git.ts:16-27`), diffs in
  JavaScript, atomic writes, escaping on every printer, and a trust gate for `quickfix.after`. Some
  features lose fidelity: churn is 0 in a treeless clone (`docs/security.md`).
- **Kept by** `processes-in-few-places`; the `repo-text-escaped`, `atomic-writes`,
  `configuration.user-only-keys`, `repository-access.git-helper`, `change-review.snapshot-safety`
  and `fixer-commands.approved-only` checklist items; and the tests in `test/config.test.ts`,
  `test/git.test.ts` and `test/trust.test.ts`.

### 6. Prefer data to code

New principles are presets in `presets/*.toml`. A language is a row of node kinds in
`src/ast/languages.ts`, and an external system is a row in `src/architecture/externals.ts`
(`CONTRIBUTING.md`, `docs/extending.md`).

- **Why.** Users get the same power as maintainers, and adding a principle needs no release.
- **Cost.** Presets need a full schema and validation (`src/presets.ts`). A repository's presets are
  repository text that can steer a model, and can add paid rule matches, which
  `max_rule_matches` caps.
- **Kept by** convention, and the preset schema in `src/presets.ts`.

### 7. Plain functions and data

`UserError` (`src/config.ts:12`) is the only class, because `cli.ts` needs `instanceof` to tell a
user's mistake from a bug. Config keys stay `snake_case` as written in TOML. TypeScript stays
erasable, so Node runs `src/` directly.

- **Cost.** Shared state lives in module scope, such as the in-flight decision map
  (`src/decision/decide.ts:164`).
- **Kept by** convention and Biome (`pnpm check`).
