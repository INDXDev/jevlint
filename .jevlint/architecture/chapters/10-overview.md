---
title: Overview
evidence: [AGENTS.md, docs/architecture.md, src/cli.ts:33-52, src/audit.ts:201-236, src/index.ts, docs/security.md]
---

jevlint is a model-based linter, shipped as a CLI and as an npm library (`src/index.ts`). It scores
every file twice: with local AST metrics (complexity, nesting, length, parameters) and with a
decision model that answers the questions of the active presets. It combines both into one score
per file and ranks files by what to refactor first, weighting low scores by churn and size.

It serves three kinds of user:

- **Developers and CI jobs** run `jevlint audit`, gate changes with `pr`, `commits` and `hook`, and
  fail a build below `fail_under` (exit code 1, see `AGENTS.md`).
- **Coding agents** receive fix prompts (`prompt`, `fix`, `quickfix`) and run as a Claude Code hook
  (`hook`, which exits 2 to reach Claude Code).
- **Teams that keep a spec or an architecture SSOT** run `spec check|drift` and
  `architecture compile|list|show|check|drift|plan` to keep code and documents in step.

### The main workflow

`src/cli.ts` routes a bare `jevlint`, or a path or flag, to `audit` (`src/cli.ts:82-88`). The
command loads the layered config, and `audit()` in `src/audit.ts:202` does the rest. It discovers
the files jevlint may read and counts churn from git. Each file is measured with ast-grep, its
`jevlint-score` pins are stripped, and its code is sent with the preset questions to the configured
provider, through a content-addressed cache. Semantic rule matches are judged one question each.
Then the pure scoring module ranks the files into an `AuditReport`, which the command prints as a
table, SARIF or JSON. Every other pipeline (change review, spec, architecture) reuses the same
engines and the same cached decision path.

### What sits around it

jevlint runs on the user's machine, and the repository it audits is attacker-controlled
(`AGENTS.md`, `docs/security.md`). It reaches the network in only three places: the decision model
provider through the AI SDK, GitHub through `gh` for `pr`, and an optional S3-compatible cache
bucket. A coding agent such as `claude` or `codex` runs only when the user asks for `fix`,
`quickfix` or `--agent`.

<!-- jevlint:diagram context -->
