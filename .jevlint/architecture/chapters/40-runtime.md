---
title: How it runs
evidence: [src/cli.ts:65-88, src/audit.ts:82-117, src/audit.ts:167-236, src/decision/decide.ts:12-15, src/decision/decide.ts:79-87, src/decision/decide.ts:163-196, src/review.ts:20-27, src/git.ts:8-27, src/fixers.ts:6-11, src/commands/quickfix.ts:1-23, src/architecture/check.ts:1-35, docs/architecture-reference.md:194-209, docs/security.md, commit:e8bda6b, commit:78e2f39, commit:a91e05b]
---

Four use cases cover most runs. Each diagram shows the components in call order. Dashed steps do
not always happen.

### Audit a repository

**Trigger.** `jevlint audit`, a bare `jevlint`, or `jevlint <path>`. `withDefaultCommand` in
`src/cli.ts:82-88` routes all three.

**What happens.** The command loads the layered config and calls `audit()`. In parallel, audit
loads the presets, discovers files, creates the decision model (unless `--ast-only`) and counts
churn. Each file then runs through `auditFile` (`src/audit.ts:120`) under `p-limit` at
`concurrency`. It is read, measured, and checked for pins. A file pin ends the work for that file
with no model call. Otherwise the stripped code goes to `decideFile` and each semantic rule match to
`judgeRules`. Last, `rank` and `repoScore` build the report.

**What comes back.** An `AuditReport`, printed as a table, `--format sarif|github`, or `--json`.
The exit code is 1 below `fail_under`.

**Where it fails.** A config error or a rejected key (HTTP 401 or 403, `src/decision/decide.ts:79-87`)
is a `UserError`. It stops the run and clears the queue, so no more provider calls are spent
(`src/audit.ts:176-178`). Any other provider error, a stalled request (5 minutes per file,
`src/decision/decide.ts:14`) or an AST crash on generated code becomes a warning on that one file
(`src/audit.ts:82-97`, `src/audit.ts:113-116`).

<!-- jevlint:diagram flow:audit -->

### Review a pull request or commits

**Trigger.** `jevlint pr [number]`, `jevlint commits <range>`, or `jevlint hook`. With no number,
`pr` reads `GITHUB_REF` in Actions, or else asks `gh` about the current branch (commit a91e05b).

**What happens.** `repository-access` resolves the change to a base and head. `reviewChange` then
writes each side's files into a new private directory with `ls-tree` and `cat-file`, refusing paths
with `..`, `.git` or `.gitignore` (`src/review.ts:20-22`). It audits both snapshots with the
caller's config, so a change cannot rewrite its own rules. Only what got worse is kept. With
`--intent`, one more request judges the change's message and diff against the base commit's
`AGENTS.md` or `CLAUDE.md`. With `--architecture`, the command adds the SSOT violations the change
introduced.

**What comes back.** A `ChangeReview` per change, as text, annotations or JSON.

**Where it fails.** `gh` and `git fetch` have deadlines (`src/git.ts:11-12`). In a partial clone, a
missing old blob makes a file look new, and `--intent` stops with an error (`docs/security.md`).

<!-- jevlint:diagram flow:pr-review -->

### Check code against the architecture SSOT

**Trigger.** `jevlint architecture check`, often with `--static` in CI, `--diff <base>` on a
branch, or `--new` against a baseline.

**What happens.** The command loads `.jevlint/architecture/` through `ssot-loading`, then calls
`checkArchitecture`. `collect()` reads every file with a grammar into outlines, from the cache when
the content hash matches. `conformance` assigns each file to a component and decides every
structural rule with a file and line. Unless `--static`, files with checklist items go to the model
through `spec-checks`' run loop, one request each. `--diff` reads the base from git and keeps only
new violations, matched without line numbers so that moved code stays matched.

**What comes back.** An `ArchitectureCheckReport`. Violations in a `status: target` component are
listed apart as `targetGaps` and do not affect the exit code
(`docs/architecture-reference.md:208-209`).

**Where it fails.** An SSOT that does not load is a `UserError` (exit 2), with every schema problem
listed. A revision starting with `-` is refused.

<!-- jevlint:diagram flow:architecture-check -->

### Hand the worst files to a coding agent

**Trigger.** `jevlint quickfix`. `fix` is the same without the edit-only limits, diff and commit.

**What happens.** The command audits, picks the worst files, and checks that each file is clean in
git. If `jevlint.toml` declares `quickfix.after`, it asks `trust.ts` whether the user has approved
these exact commands (`fixersToRun`, `src/commands/quickfix.ts:23`). `quickfixWithFixers` renders
an edit-only prompt and runs the agent. It then runs the approved fixers on the changed files,
without a shell and with a timeout (default 300 s, `src/fixers.ts:9`). With `retry = true` and a
failing fixer, the agent gets one more run with the output fenced as data. The changed files are
re-audited, and the command draws a diff it computes in JavaScript.

**What comes back.** A diff with scores before and after. By default each run is committed, and
the command prints the hash and how to undo it (commit e8bda6b). `--json` returns
`QuickfixFileResult[]`.

**Where it fails.** A dirty file, an agent that exits non-zero, or a fixer that times out (exit
code 124, `src/fixers.ts:11`). Commits are skipped outside git or after a failed run.

<!-- jevlint:diagram flow:quickfix -->
