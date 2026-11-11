---
title: Decisions
evidence: [docs/architecture.md:157-222, src/decision/providers.ts:32-40, src/decision/decide.ts:12-18, src/decision/decide.ts:177-183, src/ast/languages.ts:24-34, src/config.ts:17-19, src/trust.ts:1-5, src/git.ts:157, docs/architecture-reference.md:181-209, commit:5884c7f, commit:b44cf9c, commit:78e2f39, commit:8896cdd, commit:5f1db8a, commit:cd3216c, commit:aa2cc1a]
---

Each decision cites where it is recorded. Where an alternative is not written down, the text says
so.

### The AI SDK is the provider layer, kept in one folder

- **Context.** jevlint asks typed questions (score, boolean, choice) of several providers:
  TypeSafe, OpenAI, the Vercel gateway, Cloudflare, Microsoft and generic endpoints.
- **Decision.** Use the AI SDK's `experimental_decide`, which already handles the protocol, retries
  and validation. Cloudflare, Microsoft and generic endpoints reuse the TypeSafe provider with
  another base URL. Cloudflare's response envelope is unwrapped by a `fetch` shim
  (`src/decision/providers.ts:32-40`). All of it stays in `src/decision/` (`docs/architecture.md:159-164`).
- **Consequences.** A breaking change in the experimental API touches one folder. Provider limits
  leak upwards only as data: Cloudflare's 64-question cap is handled by splitting requests
  (`src/decision/decide.ts:15`, commit cd3216c).
- **Alternatives.** Writing a client per provider. The docs reject it implicitly ("already handles
  the protocol, retries and validation"); no further comparison is recorded.

### Cache raw answers, score afterwards

- **Context.** Model calls are slow and paid, and weights and thresholds get tuned often.
- **Decision.** The cache key is the provider, model, endpoint, questions and content. The value is
  the raw answers. `scoring.ts` runs after every lookup (`docs/architecture.md:185`).
- **Consequences.** Tuning weights is free, and pins, rule thresholds and spec thresholds all apply
  after the cache. Every caller has to go through `decideFile`/`decideState` to get this.
- **Alternatives.** Caching scores, which would re-ask the model whenever a weight changed.

### One tree-sitter API for every language, with a lexical fallback

- **Context.** Each `@ast-grep/lang-*` package is about 11 MB of prebuilt parsers. Its install
  script makes pnpm warn on every install.
- **Decision.** Use ast-grep, so a language is a table of node kinds. Bundle only Python, Go and
  Rust parsers, copied into `dist/parsers/` at build time, and keep the grammar packages as
  devDependencies (commit 5884c7f, `src/ast/languages.ts:24-34`). Every other language gets
  `src/ast/generic.ts`, a one-pass keyword and indentation reader.
- **Consequences.** The install stays small and quiet. Other languages get approximate metrics
  (`AstResult.approximate`) and no architecture facts.
- **Alternatives.** A separate analyser per language, or shipping more grammars. Both are named
  and rejected in `docs/architecture.md:166-178`.

### `quickfix` diffs in JavaScript, not with `git diff`

- **Context.** A repository's git config can make `git diff` run external diff and textconv
  programs (`src/git.ts:157`).
- **Decision.** Git only finds which files changed. jsdiff writes git-style patches that
  `git apply` accepts, and `diff-view.ts` draws them, including a built-in side-by-side view in the
  style of delta (commit b44cf9c, `docs/architecture.md:187-191`).
- **Consequences.** No repository-chosen program runs, and a redirected run prints a plain patch.
  jevlint maintains its own diff renderer.
- **Alternatives.** `git diff` with a pager such as delta. Rejected because it would run
  repository-controlled programs on repository text.

### A repository's config is stricter than the user's, with one gated exception

- **Context.** Auditing an untrusted repository must not hand it the user's keys or shell.
- **Decision.** `jevlint.toml` cannot set `provider.base_url`, `agents`, `cache` or
  `max_rule_matches` (`src/config.ts:19`). `quickfix.after` names commands but stays allowed, so a
  team can share its formatters. jevlint runs them only after the user approves that exact list.
  The approval fingerprints the root commits and the files the commands read (commits 78e2f39 and
  8896cdd, `src/trust.ts:1-5`).
- **Consequences.** Every new setting needs a decision on whether it is user-only. `--yes` never
  approves fixers, and tools in `node_modules` are not covered, so this narrows the risk without
  closing it (`docs/security.md`).
- **Alternatives.** Making `quickfix.after` user-only. The comment at `src/config.ts:17-18` gives
  the reason against it: teams share it in `jevlint.toml`.

### A coding agent writes the SSOT; jevlint decides its rules statically

- **Context.** Naming components and explaining them needs judgement. Checking imports against
  them does not.
- **Decision.** `architecture compile` collects static facts and a draft, and prints a prompt for a
  coding agent, which writes `.jevlint/architecture/` (commit 5f1db8a). `check --static`, `list`,
  `show` and `plan` decide everything from the AST with no network. The model judges only prose
  checklist items and stale summaries. `spec compile` was built the same way earlier (commit
  aa2cc1a, `docs/architecture.md:221-222`).
- **Consequences.** The SSOT is reviewable YAML that people own. CI can gate structure at no cost,
  and the prompt carries paths and names, never file contents.
- **Alternatives.** jevlint writing the SSOT itself with a model call. The record only says
  "jevlint never writes the spec"; why an agent is preferred is not written down.

### A spec is judged in two requests per file

- **Context.** A spec has a project checklist and many features. One request with every item
  would be large and mostly irrelevant to a given file.
- **Decision.** The first request asks one choice question, which feature the file belongs to,
  together with the project checklist. The second asks only that feature's items. Both go through
  `decideState` (`docs/architecture.md:217-222`).
- **Consequences.** Requests stay small and relevant. A wrong route judges a file against the
  wrong feature. `[spec] threshold` drops low-confidence verdicts.
- **Alternatives.** One request with all items, implicitly rejected by the stated reason.

### `prompt`, `fix` and `explain` re-run `audit()`

- **Context.** These commands need the latest findings for chosen files.
- **Decision.** Re-run `audit()` rather than read a stored report (`docs/architecture.md:193-194`).
- **Consequences.** No stale state and no report store. The cache makes repeat runs cheap, but a
  run with `--no-cache` pays twice.
- **Alternatives.** A saved report file, rejected for staleness.
