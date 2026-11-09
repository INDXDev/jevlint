# CLI reference

Running `jevlint` with no command is the same as `jevlint audit`, and `jevlint src` is the same as
`jevlint audit src`. A command's name wins over a directory's, so write `jevlint audit test` to audit
a directory called `test`. Every command supports `--help`, and `jevlint --version` prints the version.

Results go to stdout, and progress and notices go to stderr, so pipes stay clean. Colour follows
`NO_COLOR` and `FORCE_COLOR`.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | The repository score is below `fail_under`, `audit --new` found something new, `hook --staged` found the staged change made something worse, or [`jevlint test`](#jevlint-test-questions) found a fixture that failed or moved, `spec check` found a violated or unimplemented item, or `spec drift` found drift |
| 2 | Usage or config error, a rejected API key, a refused [cache bucket](caching.md#share-the-cache-through-object-storage), or a Node.js without the required security fixes. With `fail_under` or `--new` set, also: no file was scored, every provider request failed, or a key in the environment was never allowed. `hook` also uses it as a gate: an edit made a file worse, which is the code Claude Code feeds back to the agent |

## `jevlint audit [paths...]`

Scores files and ranks them. With `paths`, only those files or directories are audited. An argument
that names a preset and no existing path selects that preset, so `jevlint audit security` runs with
only the `security` preset, and adds to any `--preset`. A name that is neither, but close to a preset,
stops with a suggestion rather than auditing nothing. See [Choosing presets](presets.md#choosing-presets).
`baseline`, `explain`, `prompt` and `fix` read a preset name among their arguments the same way, and
`pr`, `commits`, `hook` and `test` take `--preset`.

| Flag | Description |
| --- | --- |
| `--preset <names>` | Comma-separated presets, replacing the configured ones |
| `--top <n>` | Rows to show (default 20). `--json` always includes every file |
| `--json` | Print the [JSON report](json-output.md). The same as `--format json` |
| `--format <format>` | [Output format](#output-formats): `text` (default), `json`, `sarif` or `github`. `--dry-run` takes only `text` and `json` |
| `--new` | Show only what is [new or worse than the baseline](#jevlint-baseline-paths), and exit 1 if anything is |
| `--dry-run` | List files and [estimate tokens and cost](providers.md#cost-estimates), with no provider requests. With `cache.remote` set, it reads the bucket to tell what is cached |
| `--ast-only` | Use AST analysis only, with no network calls |
| `--no-cache` | Ignore cached decisions, and do not store new ones |
| `--ignore-pins` | Score files as if no [`jevlint-score` comment](scoring.md#pinning-scores) existed |
| `--fail-under <n>` | Exit 1 if the repository score is below `n` |
| `--concurrency <n>` | Maximum parallel provider requests |

With no usable key for any provider, `audit` prints a notice and runs AST-only. `--dry-run` and `--ast-only` work
with no key.

### Output formats

`--format` works on `audit`, `pr` and `commits`, and never changes the exit code. Both CI formats list
AST findings on their line, and weak question answers (compliance below 0.7, not pinned) on line 1 of
their file, with the question id as the rule. A pinned file has nothing to list. With `pr` and
`commits`, they list only what the change made worse.

| Format | Prints |
| --- | --- |
| `text` | The terminal report |
| `json` | The [JSON report](json-output.md) |
| `sarif` | A SARIF 2.1.0 log with one run, for [code scanning](ci.md#show-findings-in-code-scanning) |
| `github` | One `::warning` [workflow command](ci.md#annotate-a-pull-request) per issue |

Paths are relative to the jevlint root, so run from the top of the repository for tools to place them.
With `commits`, lines are as of each commit, which may not match your checkout.

## `jevlint baseline [paths...]`

Audits the repository and writes what it finds to `.jevlint/baseline.json`, so that a legacy codebase
can gate on new problems today. Commit the file. It holds each file's AST findings (`rule`, `symbol`,
`value`) and weak answers (`id`, `compliance`), sorted, with no timestamps, so it diffs well. Run it
again to accept the current state.

| Flag | Description |
| --- | --- |
| `--ast-only` | Use AST analysis only, with no network |

`jevlint audit --new` then shows only what is new or worse. Findings match by rule and symbol, not by
line, so code that moves stays matched, and a finding counts only if its value got worse. A weak
answer counts if the baseline has none for that question or a higher one. These are the rules `pr`
uses. A renamed file counts as new. A pinned file counts as settled, so gate with `--ignore-pins` if
that is not enough.

```sh
jevlint baseline --ast-only
jevlint audit --new --ast-only --format github
```

- Create the baseline in the same mode as the gate. An AST-only baseline holds no answers, so a model
  gate would report every weak answer as new. A model baseline works with `--new --ast-only`.
- `paths` narrows what is recorded, and the file is replaced, not merged. Anything left out counts as
  new, so a baseline for the gate should cover at least what the gate audits.
- `--new` with no baseline is an error, and so is a baseline run where every provider request failed.
- `--new` also applies `fail_under`, if it is set. The repository score still covers every file.

## `jevlint architecture [paths...]`

Reviews the codebase, each directory and each class, and ranks them worst to best. See
[Architecture review](architecture-review.md).

| Flag | Meaning |
| --- | --- |
| `--perspective <names>` | Review only `codebase`, `directory` or `class`, comma-separated |
| `--top <n>` | Rows to show (default 20) |
| `--html <file>` | Write a visual report to this file. The file name is required |
| `--json` | Print the [JSON report](json-output.md#architecture-report) |
| `--ast-only` | Use AST analysis only, with no network |
| `--no-cache` | Ignore cached decisions, and do not store new ones |

## `jevlint spec`

Keeps documents, a checklist spec and code in agreement. See
[Spec-driven development](spec-driven-development.md) for the guide and the
[spec reference](spec-reference.md) for the format and the questions.

| Command | What it does |
| --- | --- |
| `jevlint spec compile [docs...]` | Print a prompt that tells a coding agent to write or update the spec from the documents. `--copy` copies it instead. Makes no network call |
| `jevlint spec check [paths...]` | Judge code files against the spec. Exits 1 when an item is violated or unimplemented |
| `jevlint spec drift [docs...]` | Compare documents with the spec. Exits 1 on a contradiction, an uncovered document, an unbacked item or an undocumented feature |
| `jevlint spec list` | Load and print the spec. Exits 2 when it does not load |

`check` and `drift` take `--copy`, which also copies a Markdown prompt asking a coding agent to fix
what was found: the code for `check`, the documents and the spec for `drift`. The report still
prints. Both list every file or document with its checklist and verdict counts, and `--verbose` adds
every item with its verdict and confidence. `check`, `drift` and `list` take `--json` (see [JSON output](json-output.md#spec-reports)). `check`
and `drift` take `--no-cache`, and need a decision model.

## `jevlint pr [number]`

Reviews what a GitHub pull request changes, not the whole repository. Needs the
[GitHub CLI](https://cli.github.com), signed in. Each changed file is audited at the merge base and
at the pull request's head, and the output shows its score before and after, the AST findings the
change introduced or made worse, and the weak question answers (compliance below 0.7) it lowered.

With no `number`, it takes the one in `GITHUB_REF` when that is `refs/pull/<number>/merge`, as in a
GitHub Actions `pull_request` run, and otherwise the pull request of the current branch.

Your working tree stays as it is. Files are read from git into a temporary directory, and the
config comes from your checkout, so a pull request cannot change the rules it is judged by. The
commits are fetched from `origin`. If the pull request lives on another remote, fetch them first:
the command prints how.

| Flag | Description |
| --- | --- |
| `--json` | Print the [JSON report](json-output.md#change-reviews). The same as `--format json` |
| `--format <format>` | [Output format](#output-formats): `text` (default), `json`, `sarif` or `github` |
| `--ast-only` | Use AST analysis only, with no provider requests |
| `--no-cache` | Ignore cached decisions, and do not store new ones |
| `--ignore-pins` | Score files as if no [`jevlint-score` comment](scoring.md#pinning-scores) existed |
| `--intent` | Also [judge the change](#judging-a-change-with---intent) against its message and the repository's instructions. Cannot be used with `--ast-only`, or with `--format sarif` or `github`, which report per file |

A model run audits each file twice, so it can cost twice what `audit` does for those files. Cached
answers are free, and model scores vary a little between versions of a file, so read a small change
in score as noise.

```sh
jevlint pr --ast-only      # this branch's pull request
jevlint pr 42 --ast-only
jevlint pr 42 | gh pr comment 42 --body-file -
```

## `jevlint commits [revision]`

Reviews commits one at a time, each against its parent, from `revision` (default `HEAD`) backwards.
The output is the same as `pr`, and it takes the same flags. This needs only git, and full history:
a shallow clone is refused. Merge commits are skipped, as they would review their branch again.

| Flag | Description |
| --- | --- |
| `--count <n>` | Commits to review (default 10) |

```sh
jevlint commits --count 5 --ast-only
jevlint commits v1.2.0 --count 3
```

A renamed file counts as new in both commands. Both only report: `fail_under` does not apply, so they
exit 0 whatever the scores.

### Judging a change with `--intent`

`--intent` on `pr` or `commits` asks one more thing of each change: does it do what it says, and does
it keep to the repository's own rules? It sends the message, the instructions and the diff to the
model in one request, with the questions of the built-in `change-intent` preset:

- Does the message describe what the diff does?
- Does the diff do things the message does not mention?
- Does the diff break an explicit instruction? Asked only when there are instructions.

The message is the full commit message, or a pull request's title and body. The instructions are
`AGENTS.md`, or `CLAUDE.md` when that is absent or empty, in the directory jevlint treats as the root.
They are read from the **base** commit, not the head, so a change cannot rewrite the rules it is judged
by, and a root commit has none. The diff leaves out every file `audit` would never read:
[secret files](configuration.md#files-that-are-always-excluded), `.gitignore` matches and `exclude`.

The output gains one line when no answer is weak, or each weak answer (compliance below 0.7) with its
fix. A diff longer than `max_file_chars` is cut, which the output says. The message comes first, so
it survives. A long message or instructions leave less room for the diff, so read that warning as
"the model did not see everything".

With no key for any provider this warns and carries on without it, as the rest of the review does.
It is off by default, as it costs one more request per change and
[sends more data](security.md#what-leaves-your-machine). Set a question's
[weight](presets.md#tuning) to 0 to stop asking it, as in `"change-intent.no-unmentioned-changes" = 0`.

```sh
jevlint pr 42 --intent
jevlint commits --count 5 --intent --json
```

## `jevlint test [questions...]`

Proves that questions work, and warns when a model update moves them. Scores are a model's opinion,
so a preset author keeps [fixtures](presets.md#testing-a-question): files the question should pass and
fail. Each fixture is sent with only its own question. A `good-*` file must reach compliance 0.7, and
a `bad-*` file must stay below it.

With question ids, as `readable-code.naming`, only those are tested. They must be active, and have
fixtures. Everything else in `.jevlint/fixtures/` that names no active question gets a warning.

| Flag | Description |
| --- | --- |
| `--preset <names>` | Comma-separated presets, replacing the configured ones |
| `--json` | Print the [results as JSON](json-output.md#fixture-results) |
| `--record` | Write the results to `.jevlint/calibration.json`, to commit. It covers every fixture, so it takes no question ids or `--preset` |
| `--drift` | Compare with the record, and list fixtures that moved |
| `--drift-limit <n>` | Compliance change that counts as a move (default 0.1) |

A plain run uses the cache. `--record` and `--drift` ask afresh and store nothing, because a cached
answer would hide what the model says today. If the record is from another provider or model, `--drift`
says so on stderr and compares anyway. A fixture added since then gets a warning, and is not compared.

This needs a model: with no key, it stops with exit code 2. It also stops with 2 when a request
fails, without writing a record, since that proves nothing about a question. It exits 1 if any fixture
failed or, with `--drift`, moved by the limit or more.

```sh
jevlint test
jevlint test readable-code.naming
jevlint test --record
jevlint test --drift --drift-limit 0.2
```

## `jevlint explain <file>`

Shows a file's score, its worst AST findings with line numbers, and every question's compliance,
worst first. `--json` prints the file's [report](json-output.md). `--preset <names>`, or a preset name
beside the file, as in `jevlint explain security src/a.ts`, replaces the configured presets.

## `jevlint prompt [files...]`

Prints a Markdown fix prompt. With no files, it uses the highest-priority files.

| Flag | Description |
| --- | --- |
| `--top <n>` | Number of files with issues to include (default 1) |
| `--preset <names>` | Comma-separated presets, replacing the configured ones |
| `--copy` | Copy to the clipboard instead of printing |

```sh
jevlint prompt --top 3 --copy
jevlint prompt security --copy
jevlint prompt | claude -p
jevlint prompt | codex exec -
```

## `jevlint fix [files...]`

Runs a coding agent, one file at a time, then re-scores each file. See
[Coding agents](agents.md).

| Flag | Description |
| --- | --- |
| `--agent <name>` | Agent to run. Built-in: `claude`, `codex` |
| `--top <n>` | Number of files with issues to fix (default 1) |
| `--preset <names>` | Comma-separated presets, replacing the configured ones |
| `--yes` | Skip the confirmation. Required when not running in a terminal |
| `--allow-dirty` | Run even if the git working tree has changes |
| `--agent-login` | Use the agent's own login, such as a Claude or ChatGPT subscription, instead of an API key in the environment. See [Coding agents](agents.md#use-your-subscription-not-an-api-key) |

## `jevlint quickfix [files...]`

Runs a coding agent on the worst file, or the files you name, with a prompt that allows only file
edits. Then it prints what changed as a diff, re-scores each changed file with an audit, and commits
that file's changes with git. With `--top <n>` or several files, it runs the agent on one file at a
time, in priority order, with one commit each. It takes the same flags as `fix`, plus
`--side-by-side`, `--no-commit` and `--json`. See
[Coding agents](agents.md#jevlint-quickfix).

| Flag | Description |
| --- | --- |
| `--agent <name>` | Agent to run. Built-in: `claude`, `codex` |
| `--top <n>` | Number of files with issues to fix (default 1) |
| `--preset <names>` | Comma-separated presets, replacing the configured ones |
| `--yes` | Skip the confirmation. Required when not running in a terminal |
| `--allow-dirty` | Run even if the git working tree has changes |
| `--agent-login` | Use the agent's own login, such as a Claude or ChatGPT subscription, instead of an API key in the environment. See [Coding agents](agents.md#use-your-subscription-not-an-api-key) |
| `--side-by-side` | Show old and new lines in two panels. On by default in a terminal at least 120 columns wide. `--no-side-by-side` turns it off |
| `--no-commit` | Leave the changes in the working tree. By default each file's run is committed |
| `--json` | Print each file with its scores, diffs and commit as [JSON](json-output.md#quickfix) |

The diff goes to stdout. A `git diff --stat` style summary, with each file's score before and after,
goes to stderr with the agent's own output:

```text
 src/orders/process.ts | +24 -31  score 21 -> 58 (+37)
 src/orders/charge.ts  | +18 -0   score 92  (new)
 2 files changed, 42 insertions(+), 31 deletions(-)
```

In a terminal the diff is coloured, and the words that changed within a line are highlighted. Wide
enough, it is side by side, as [delta](https://github.com/dandavison/delta) shows it: a title bar
per file, and the old lines on the left beside the new ones on the right, each numbered. Piped or
redirected, it is a plain patch that `git apply` accepts, unless you pass `--side-by-side`:

```sh
jevlint quickfix --agent claude
jevlint quickfix clean-code src/orders/process.ts --agent codex --yes
jevlint quickfix --top 5 --agent claude --yes      # five files, one agent run each
jevlint quickfix --agent claude --yes > quickfix.patch
```

Each commit is made with the `git` command line, takes only the files that run changed, and is
announced on stderr:

```text
Committed 3f2a9c1 "Refactor src/orders/process.ts with jevlint quickfix" (2 files). Undo with: git reset --soft HEAD~1
```

Its message gives the score before and after, the files, and that no tests ran. Your hooks and
signing settings apply as for any commit, and a failed commit stops the run with exit code 2.
`quickfix` does not commit outside a git repository, or a run that touched a file that already had
uncommitted changes, as `--allow-dirty` allows, because the commit would take in your own edits. It
says so instead.

If the agent exits with an error, `quickfix` still prints what it changed, skips the re-score and
the commit, and exits 2 without going on to the next file. When an
API key in the environment may be the cause, the error says so and suggests `--agent-login`.

## `jevlint hook`

Reports what an edit or a commit is about to make worse, for [agent hooks](agents.md#check-every-edit)
and [pre-commit](ci.md#check-commits-before-they-are-made). It uses AST metrics only, so it is fast,
free and sends nothing, unless you pass `--model`.

With no flag it reads JSON on stdin, either Claude Code's `{"tool_input":{"file_path":"..."}}` or a
flat `{"file_path":"..."}`, and compares that file on disk with `HEAD`. A path relative to the current
directory works. A new file counts as all new, and problems already in `HEAD` are not reported.

| Result | Exit code | Output |
| --- | --- | --- |
| The edit made the file worse | 2 | The findings, on stderr |
| Nothing got worse | 0 | None |
| No path, a path outside the root, an excluded or unscorable file, no git repository, or more than 32 MiB of input | 0 | None |
| Invalid JSON | 2 | An error on stderr |

| Flag | Description |
| --- | --- |
| `--staged` | Review the staged change against `HEAD`, not an edit. Exits 1 with the report on stdout if it made anything worse, and 0 with no output if not |
| `--model` | Also ask the provider. This sends both versions of each file and costs money |
| `--preset <names>` | Comma-separated presets, replacing the configured ones |

```sh
echo '{"file_path":"src/orders.ts"}' | jevlint hook
jevlint hook --staged
```

Like `pr` and `commits`, `--staged` uses your checkout's config and presets. A renamed file counts as
new.

## `jevlint init`

Creates a config file interactively. It asks for the provider and the default presets, starting with
`full` selected.

| Flag | Description |
| --- | --- |
| `--user` | Write `~/.config/jevlint/config.toml` instead of `jevlint.toml` |
| `--yes` | Accept defaults without prompting |
| `--force` | Replace an existing file |
| `--preset <names>` | Comma-separated default presets to write. In a terminal, they start selected in the prompt |
| `--pre-commit` | Install a git pre-commit hook that runs `jevlint hook --staged`, and write no config. A different hook stays unless you pass `--force` |

## `jevlint auth`

| Command | Description |
| --- | --- |
| `auth set <provider>` | Prompt for a key and store it. Pipe the key in for scripts |
| `auth list` | Show each provider and where its key comes from. Keys are never printed |
| `auth remove <provider>` | Delete a stored key |
| `auth env on\|off` | Allow or refuse keys from environment variables. Off until you allow it |

## `jevlint preset`

Run alone in a terminal, `jevlint preset` lets you pick a preset and then show it, edit it, add it to
or remove it from the defaults, copy it into a new preset, or remove it. In a pipe, it prints
`preset list`. `show`, `edit` and `remove` also let you pick when you leave out the name.
`jevlint audit --help`, `jevlint init --help` and `jevlint preset --help` list the presets with examples.

| Command | Description |
| --- | --- |
| `preset list` | Show available presets, grouped by the command they serve, and where each comes from. `*` marks the default ones |
| `preset show [name]` | Print a preset's questions. `--toml` prints its file instead |
| `preset default [names...]` | Set the presets every audit uses, in your user config or with `--repo` in `jevlint.toml`. With no names, pick them in a terminal, or print them in a pipe |
| `preset new <name>` | Write a new preset to your user presets and open it in `$VISUAL` or `$EDITOR`. `--from <preset>` copies another, `--repo` writes into `.jevlint/presets/`, `--no-edit` skips the editor |
| `preset edit [name]` | Open a preset in your editor, then check it. A built-in one is copied first, to your user presets or with `--repo` to `.jevlint/presets/`, and the copy overrides it. `--path` prints the file instead |
| `preset add <file>` | Install a preset TOML for your user. `--repo` installs into `.jevlint/presets/` |
| `preset remove [name]` | Remove an installed preset. Built-in presets cannot be removed |

## `jevlint cache`

| Command | Description |
| --- | --- |
| `cache info` | Show the location, entry count and size, and the bucket if one is set |
| `cache clear` | Delete all locally cached decisions. A [bucket](caching.md#share-the-cache-through-object-storage) keeps its own |

## `jevlint config`

| Command | Description |
| --- | --- |
| `config show` | Print the merged config as TOML, without secrets |
| `config path` | Print the config files in use, in the order they apply |
