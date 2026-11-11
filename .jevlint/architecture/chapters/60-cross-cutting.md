---
title: Cross-cutting concerns
evidence: [AGENTS.md, src/cli.ts:29, src/cli.ts:127-147, src/cli.ts:196-203, src/config.ts:11-19, src/config.ts:294-310, src/config.ts:343-399, src/report.ts:38-46, src/git.ts:16-27, src/commands/shared.ts:19-20, src/commands/architecture.ts:95-100, src/decision/decide.ts:12-18, src/audit.ts:167-182, src/architecture/load.ts:36-53, src/node-version.ts:1-8, docs/security.md, commit:f6c2055]
---

### Errors and exit codes

There are two kinds of error. `UserError` (`src/config.ts:12`) is anything the user can fix: bad
config, an unknown flag, a rejected key, an SSOT that does not load. `reportError` in
`src/cli.ts:196-203` prints it as `Error:` and exits 2. Anything else is printed as
`Unexpected error:`, with the stack under `DEBUG`. Citty's own usage errors are turned into
`UserError`s by name (`src/cli.ts:143-147`). Unknown flags are rejected because citty would
silently drop them (`src/cli.ts:127-134`).

The exit codes are a contract (`AGENTS.md`): 0 success, 1 a check failed, 2 usage, config or gate
error. `hook` uses 2 on purpose, because that is how a Claude Code hook reaches the agent. Per-file
problems, such as an unreadable file, an AST crash or a provider error, are warnings in the report,
not errors.

### Security and trust boundaries

The repository is hostile, and the boundary runs through several modules:

| Threat | Defence | Where |
| --- | --- | --- |
| A repository config redirects a key or names a command | `USER_ONLY_KEYS` refuses `provider.base_url`, `agents`, `cache` and `max_rule_matches` in `jevlint.toml`. A user's `base_url` is dropped when the repository names another provider | `src/config.ts:19`, `src/config.ts:389-399` |
| An API key in a config file | Any `api_key` key is refused | `src/config.ts:343-354` |
| git runs a program from `.git/config` | `git()` sets `safe.bareRepository=explicit`, `core.fsmonitor=false` and `GIT_NO_LAZY_FETCH`. Reads use plumbing (`diff-tree`, `cat-file`, `ls-files`), not `git diff` or `git show` | `src/git.ts:16-27` |
| A crafted tree escapes a snapshot | `UNSAFE_PATH` refuses `..`, `.git` and `.gitignore` | `src/review.ts:20-22` |
| A planted symlink redirects a write | `writeFileAtomic` writes a temp file, then renames it over the target | `src/config.ts:294-304` |
| A FIFO or device hangs a read | `readRegularFile` refuses anything but a regular file | `src/config.ts:306-310` |
| Repository text drives the terminal | `withoutEscapes` and `withoutControlCharacters` turn control characters and bidi overrides into `?` | `src/report.ts:38-46` |
| The SSOT names something outside the root | Globs with `..` or a leading `/` are refused | `src/architecture/load.ts:47-52` |
| `quickfix.after` runs repository commands | They run only after an approval that fingerprints their inputs, without a shell | `src/trust.ts`, `src/fixers.ts` |

`docs/security.md` lists what each command sends and the risks that remain, such as prompt
injection aimed at a model. jevlint also refuses to start on a Node release with known holes
(`src/node-version.ts:3-8`), because `engines` only warns under npm.

### Configuration

Four layers merge in order: defaults (`src/config.ts:197`), the user's `config.toml`, the nearest
`jevlint.toml` found upwards (`findUp`, `src/config.ts:376`), then flags. Keys stay `snake_case` as written in TOML. Each layer is
validated by a strict zod schema, so an unknown key is an error with its path. A new setting that
names an endpoint, a command or a path on the user's machine goes into `USER_ONLY_KEYS`.

### Caching

Every model request goes through one content-addressed cache. Its key is described in "Data and
state". Identical files in one run share a single lookup (`src/decision/decide.ts:163-175`). With
`--no-cache`, nothing is read or written.

### Concurrency and deadlines

`p-limit` caps files in flight at `concurrency` (default 8). Rule matches in a file are asked one at
a time, so `concurrency` stays the limit for the whole run (`docs/architecture.md`). A fatal error
clears the queue (`src/audit.ts:176-178`). Each file's provider call, `gh`, `git fetch` and each
fixer has a deadline, added after a stalled network hung a run (commit f6c2055).

### Output contracts

stdout carries only results. Warnings, spinners and prompts go to stderr (`PROMPT_IO`,
`src/commands/shared.ts:20`). `--json` prints the report shapes of `src/types.ts`, which
`docs/json-output.md` documents and which keep the original repository text. The AI SDK's console
warnings are switched off (`src/decision/decide.ts:18`), so even a dependency cannot break this.

### Observability

There is no telemetry and no server (`docs/security.md`). A run reports its own usage instead:
input tokens, estimated cost, cache hits and model calls in `AuditReport.usage`. `--dry-run`
shows what would be sent before anything is sent.
