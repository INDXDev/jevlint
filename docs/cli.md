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
| 1 | The repository score is below `fail_under`, `audit --new` found something new, `hook --staged` found the staged change made something worse, or [`jevlint test`](#jevlint-test-questions) found a fixture that failed or moved, `spec check` found a violated or unimplemented item, `spec drift` found drift, `architecture check` found a violation or an unimplemented item, `architecture drift` found drift, `pr --architecture` or `commits --architecture` found a violation the change added, or `pr --acceptance` found a criterion the pull request does not meet |
| 2 | Usage or config error, an architecture SSOT that does not load, a rejected API key, a refused [cache bucket](caching.md#share-the-cache-through-object-storage), or a Node.js without the required security fixes. With `fail_under` or `--new` set, also: no file was scored, every provider request failed, or a key in the environment was never allowed. `hook` also uses it as a gate: an edit made a file worse, which is the code Claude Code feeds back to the agent |

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
again to accept the current state. When an [architecture SSOT](architecture-reference.md) exists, it
also records its structural violations (`rule`, `rule_id`, `path`, `target`, without lines), which
`jevlint architecture check --new` leaves out. An SSOT that does not load leaves them out with a
warning on stderr, and the audit baseline is written anyway.

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

## `jevlint architecture`

Reviews the structure, and compiles, shows and checks the architecture SSOT: a small set of YAML
files in `.jevlint/architecture/` that describes the system's components, layers and rules. See
[Architecture review](architecture-review.md), the guide
[Architecture-driven development](architecture-driven-development.md) and the
[SSOT reference](architecture-reference.md).

| Command | What it does | Model |
| --- | --- | --- |
| `jevlint architecture [paths...]` | The same as `review` | As `review` |
| `jevlint architecture review [paths...]` | Review the codebase, directories, classes and, with an SSOT, each component and the design. Rank them worst to best. An SSOT that does not load is skipped with a warning, unless `--perspective` asks for it | Yes, unless `--ast-only` |
| `jevlint architecture compile [paths...]` | Print a prompt that tells a coding agent to write the SSOT from the code, or to update it | No |
| `jevlint architecture list` | Load and validate the SSOT, and print it. Exits 2 when it does not load, and warns on stderr when it is over the size budget or its views, chapters and decisions do not fit the code. `--json` prints it, and `--as-of <commit\|date>` reads it [as it was](#reading-the-ssot-as-it-was-with---as-of) | No |
| `jevlint architecture show` | Draw the SSOT, or a draft from the code when there is none, with the real dependencies laid over the declared ones | No |
| `jevlint architecture check [paths...]` | Check that the code follows the SSOT. Exits 1 on a violation or an unimplemented checklist item | Checklist items only |
| `jevlint architecture drift` | Find where the SSOT no longer describes the code. Exits 1 when it finds any | Summaries and `--docs` only |
| `jevlint architecture plan` | Rank structural problems by severity, churn and fan-in, with a computed move for each | No |

Anything after `jevlint architecture` that is not one of these commands goes to `review`, so
`jevlint architecture src --ast-only` works as it always did, and its output does not change while
there is no SSOT.

### `review`

| Flag | Meaning |
| --- | --- |
| `--perspective <names>` | Review only some of `codebase`, `directory`, `class`, `component`, `design`, `chapter` and `decision`, comma-separated. The last four need an SSOT |
| `--top <n>` | Rows to show (default 20) |
| `--html <file>` | Write a visual report to this file. The file name is required |
| `--json` | Print the [JSON report](json-output.md#architecture-report) |
| `--copy` | Also copy a prompt asking a coding agent for a prose review of the design |
| `--prompt` | Print that prompt instead of the report, for `jevlint architecture review --prompt \| claude -p` |
| `--ast-only` | Use AST analysis only, with no network |
| `--no-cache` | Ignore cached decisions and outlines, and do not store new ones |

### `compile`

Collects [facts](architecture-reference.md#facts) from the code with no network, builds a draft
SSOT from them, and prints a prompt that tells a coding agent to write the whole architecture
document in `.jevlint/architecture/`: the structure, curated diagrams (`views/`) and chapters
(`chapters/`) that explain the design and the reasons behind it. The prompt adds the material for
those reasons: instruction files, data types, comments in central files and the commits most worth
reading. See [Compile](architecture-reference.md#compile). When an SSOT exists, the prompt asks for
an update of what changed since `compiled_at` instead, keeping ids and rewriting only stale chapters
and views. The prompt holds paths, line numbers, names and commit subjects, never file contents. It
exits 0 even when the current SSOT does not load, and the prompt then says why.

With `--agent`, jevlint then runs the checks of `list` and, while they report anything, hands the
problems back to the agent, at most twice.

| Flag | Meaning |
| --- | --- |
| `--docs` | Add the documents `spec.docs` matches as context. `--docs README.md` or `--docs=README.md,docs/design.md` names them instead |
| `--since <commit>` | Base an update on this commit instead of `compiled_at` |
| `--copy` | Copy the prompt to the clipboard instead of printing it |
| `--agent <name>` | Run this [agent](configuration.md#agents) on the prompt, with its output on stderr |
| `--agent-login` | Use the agent's own login, not an API key in the environment |
| `--no-cache` | Ignore cached outlines |

### `show`

| Flag | Meaning |
| --- | --- |
| `--view <view>` | `map` (default), `layers`, `flow:<id>`, `component:<id>`, or the id of a view such as `overview` |
| `--markdown` | Print the SSOT as an ARCHITECTURE.md with Mermaid diagrams, built around its chapters when it has them, or only the chosen `--view` |
| `--html <file>` | Write one page with no scripts and no network requests |
| `--json` | Print the SSOT, the map edges and the facts |
| `--as-of <commit\|date>` | Show the SSOT and the code [as they were](#reading-the-ssot-as-it-was-with---as-of) at a commit or on a date |

With no SSOT, `show` draws the component candidates from the facts and says on stderr that this is a
draft. jevlint never writes into `docs/`: redirect `--markdown` yourself, as in
`jevlint architecture show --markdown > docs/ARCHITECTURE.md`.

### Reading the SSOT as it was with `--as-of`

`list --as-of` and `show --as-of` read the SSOT and the code from git as they were at a revision, and
render them with every check `list` and `show` apply today. Git is the store; decision records are
the index into it. Nothing is checked out: the SSOT's files are copied from git into a private
directory that is deleted afterwards, and the code is read with `ls-tree` and `cat-file`, so the
working tree and the index stay as they are.

The value is a revision, such as a commit or a tag, or a date as `YYYY-MM-DD`. A date means the last
commit on the first-parent history of `HEAD` committed before that day ended in UTC: the branch as it
stood then, not a commit of a branch that was merged later. Commit dates are when something was
committed, not when it was decided, so read a date as approximate. With no SSOT at that revision,
`list` exits 2 and `show` draws the draft from the code at that revision.

```sh
jevlint architecture show --as-of v0.2.0 --markdown
jevlint architecture list --as-of 2026-11-01
```

### `check`

| Flag | Meaning |
| --- | --- |
| `--static` | Decide the structural rules only, with no model |
| `--diff <base>` | Report only the structural violations the change since `base` added, and judge checklists only in changed files |
| `--new` | Leave out violations recorded in `.jevlint/baseline.json` by [`jevlint baseline`](#jevlint-baseline-paths) |
| `--json` | Print the [JSON report](json-output.md#architecture-ssot-reports) |
| `--copy` | Also copy a prompt asking a coding agent to fix the code |
| `--prompt` | Print that prompt instead of the report |
| `--verbose` | List every judged checklist item with its verdict and confidence |
| `--no-cache` | Ignore cached decisions and outlines |

`paths` narrows what is reported, not what is analysed, so a violation from outside still counts when
its file is in `paths`. Violations in a component with `status: target` are listed separately as the
distance from the target, and do not affect the exit code.

### `drift`

| Flag | Meaning |
| --- | --- |
| `--static` | AST only: unmapped code, undocumented dependencies and externals, stale references |
| `--docs` | Also compare documents with the SSOT. `--docs a.md` or `--docs=a.md,b.md` names them. Cannot go with `--static` |
| `--since <commit>` | Compare with this commit instead of `compiled_at` |
| `--json`, `--copy`, `--prompt`, `--no-cache` | As for `check`. The prompt asks an agent to update the SSOT |

### `plan`

| Flag | Meaning |
| --- | --- |
| `--json` | Print the plan as JSON, for `> .jevlint/architecture/plan.json` |
| `--prompt` | Print a prompt asking a coding agent to write `plan.md` from the plan |
| `--copy`, `--agent <name>`, `--agent-login` | Copy the prompt, or run an agent on it |

With no SSOT, `plan` uses the draft components. No command changes code.

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
| `--architecture` | Also report the [architecture SSOT](architecture-reference.md) violations the change added, decided from the AST at both commits with no model. Needs an SSOT, and `--format text` or `json` |
| `--acceptance` | `pr` only. Also [judge the pull request](#judging-a-pull-request-with---acceptance) against the acceptance criteria in its body and the issues it closes. Cannot be used with `--ast-only`, or with `--format sarif` or `github` |

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
exit 0 whatever the scores. The exceptions are `--architecture`, which exits 1 when a change added an
SSOT violation, and `--acceptance`, which exits 1 when the pull request does not meet a criterion, so
either can gate a pull request.

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

### Judging a pull request with `--acceptance`

`--acceptance` on `pr` asks the question a reviewer cares about most: does the pull request do what
was asked? It answers in two stages, both with the decision model.

1. **Extract.** It reads the pull request's body and the body of each issue in its closing
   references: the issues GitHub closes on merge, written as `Fixes #12` or linked in the sidebar.
   Issues in another repository are named in a warning and not read, nor are comments. Each text is
   cut into chunks, line by line: each checklist item, each list item, and each sentence of a
   paragraph, with the headings above it. Code blocks, tables, HTML comments and quoted text are left
   out. Each chunk is asked one question of the built-in `acceptance-criteria` preset, in a request
   of its own: is it a condition the finished change must meet, specific enough to check against
   the code? A chunk is a criterion at a probability of 0.5 or more. Headings are context, not a
   filter, so a checklist under "Out of scope" is asked about too, and rejected.
2. **Judge.** It asks how far the diff meets each criterion, with one choice question per criterion
   in one request, at most 64 to a request. The criteria come before the diff, so a long diff is cut
   rather than them. The diff is the one `--intent` sends.

| Verdict | Meaning | Points |
| --- | --- | --- |
| `met` | The diff does what the criterion asks | 1 |
| `partly` | The diff does part of it | 0.5 |
| `not-met` | The diff does not do it, or contradicts it | 0 |
| `cannot-tell` | A diff cannot show it, as for "deployed" or "reviewed by a person" | Not counted |

The score is the points over the criteria that count, on the configured scale. The output lists
each criterion with its verdict and where it comes from (`PR` or `#<n>`), and says how many chunks
were not criteria; `--json` lists those too. The command exits 1 when any criterion is `not-met`.
Finding no criteria is a warning, not a failure, and so is an issue `gh` cannot read.

Every chunk is a small request, cached on its own, so running the command again costs nothing until
the text or the diff changes. A long issue still makes many requests the first time, so the command
warns on stderr when there are more chunks than `warn_file_count`. With no key for any provider it
warns and carries on without it. The criteria are read as they are now, not as they were when the
pull request was opened, so whoever can edit the body or the issues can change them. See
[Security](security.md#what-leaves-your-machine) for what is sent.

```sh
jevlint pr 42 --acceptance
jevlint pr 42 --acceptance --json   # for CI
jevlint pr --acceptance --intent    # with other questions
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
| `--allow-dirty` | Run even if the git working tree has changes, or outside a git repository |
| `--agent-login` | Use the agent's own login, such as a Claude or ChatGPT subscription, instead of an API key in the environment. See [Coding agents](agents.md#use-your-subscription-not-an-api-key) |

Without `--allow-dirty`, `fix` and `quickfix` need a git repository with no uncommitted changes
under the project root. Changes elsewhere in the repository, such as a sibling package in a
monorepo, do not count. Outside a repository, or when git fails, the error gives git's reason. With
uncommitted changes, it names the first few files.

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
| `--allow-dirty` | Run even if the git working tree has changes, or outside a git repository |
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

### Formatters and checks after the agent

When the config declares [`[[quickfix.after]]`](configuration.md#quickfix-after) commands, such as a
formatter, `quickfix` runs them after the agent succeeds, on the files it changed. The diff, the
re-score and the commit then show the code after those commands. Their output goes to stderr, so
stdout stays a patch or JSON. A command that exits non-zero gets a warning and does not stop the
run. A command that runs past its `timeout`, 300 seconds by default, is stopped and counts as
failed. A command marked `retry = true` that still fails gives the agent one more run, with the
command's output, to fix only those errors. Then the commands run again, and the run goes on
whatever the result. The commit message names the commands that ran, the checks that caused the
retry, any that still fail, and the files only the commands changed, apart from the agent's.

Commands from a repository's `jevlint.toml` run only once you approve them. In a terminal,
`quickfix` lists them and asks before the first agent runs. With `--yes` or outside a terminal it
skips them and says so, because `--yes` never approves them. Approve them ahead of time with
[`jevlint trust`](#jevlint-trust). Before each round of commands, `quickfix` checks the approval
again, and skips them if the agent changed a file they read.

## `jevlint trust`

Lists the `quickfix.after` commands in this repository's `jevlint.toml`, and the files they read,
and approves them, after asking. The approval is kept in `~/.config/jevlint/trusted.json` for this
project root. Changing any command, its `files` or `retry`, the repository's history, or a file the
commands read, such as a script they name or `package.json` for `pnpm`, asks again. See
[Quickfix after](configuration.md#quickfix-after) for what it covers.

| Flag | Description |
| --- | --- |
| `--yes` | Approve without asking. Required outside a terminal |
| `--revoke` | Withdraw the approval for this repository |

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
