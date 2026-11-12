# Changelog

This project follows [Semantic Versioning](https://semver.org).

## Unreleased

## 0.2.6 - 2026-11-12

- **An architecture SSOT compiled from the code.** `jevlint architecture` is now a command group,
  and with no subcommand it runs `review`, whose output does not change until an SSOT exists.
  Static analysis collects facts from every file with no network: imports with line numbers,
  external packages classified by system, component candidates from directories and import
  cohesion, inferred layers, entry points, public interfaces, flows and co-changes. The new verbs
  use them. See [Architecture-driven development](docs/architecture-driven-development.md) and the
  [SSOT reference](docs/architecture-reference.md).
  - `compile` prints a prompt with the facts and a draft that tells a coding agent to write
    `.jevlint/architecture/`, or to update it from what changed since `compiled_at`. `--copy`
    copies it, `--agent` runs the agent, and `--docs` adds documents as context.
  - `list` validates the SSOT, exits 2 when it does not load, and warns when it is over the size
    budget.
  - `show` draws the SSOT, or the draft when there is none, with real dependencies laid over the
    declared ones: `--view map|layers|flow:<id>|component:<id>`, `--markdown` for an
    ARCHITECTURE.md with Mermaid, `--html` for one offline page, and `--json`.
  - `check` decides every structural rule from the AST with a file and line (`layers`,
    `depends_on`, `only`, `forbid`, `forbid-call`, `no-cycles`, flows, stale references, unmapped
    files), and judges checklist items with the decision model unless `--static`. `--diff <base>`
    reports only what a change added, `--new` leaves out what `jevlint baseline` recorded, and
    components with `status: target` are reported as distance from the target.
  - `drift` reports unmapped code, undocumented dependencies and externals, stale references, and
    with a model, stale summaries and documents with `--docs`.
  - `plan` ranks problems by severity, churn and fan-in and computes a move for each, such as the
    cheapest edge to cut in a cycle. `--prompt`, `--copy` and `--agent` ask an agent for `plan.md`.
  - `review` adds the `component` and `design` perspectives when an SSOT exists, from the new
    `architecture-component` and `architecture-design` presets, and `--copy`/`--prompt` give a
    prompt for a prose review.
- **The SSOT is also the architecture document.** It can hold curated diagrams in `views/` (a system
  context, the building blocks, a data model as an ER diagram) and chapters in `chapters/` with
  cited evidence. `show --markdown` builds an ARCHITECTURE.md around the chapters, with diagrams
  compiled to Mermaid in GitDiagram's style: subsystems as coloured boxes, shapes by kind, verbs on
  the arrows. `compile` now asks the agent to write all of it, with rules for drawing from
  GitDiagram's generator, a fixed chapter outline and writing rules, and with material for the
  reasons: data types, comments in central files and the commits most worth reading. jevlint checks
  every solid arrow against the imports and every citation against the files, `compile --agent`
  hands what fails back to the agent, `drift` reports chapters whose cited files changed, and
  `review` adds a `chapter` perspective.
- **`pr --architecture` and `commits --architecture`** report the SSOT violations each change
  added, with no model, and exit 1 when there are any. `--json` adds `architecture` to each review.
- **`jevlint baseline` records architecture violations** when an SSOT exists, for
  `architecture check --new`.
- The architecture review now resolves TypeScript `paths` from the root `tsconfig.json` and pnpm,
  npm and bun workspace packages, so those links are no longer missing.
- `jevlint test` finds fixtures for the questions of the architecture presets without adding them
  to `presets`.
- New setting `architecture.dir`, where the SSOT lives. Default `.jevlint/architecture`.
- The library API exports `checkArchitecture`, `driftArchitecture`, `loadArchitecture`,
  `planArchitecture` and `collectArchitectureFacts`.

- **`[[quickfix.after]]`: run the project's formatters and fixers after `quickfix`.** Each entry
  names a command and optional `files` patterns. After the agent succeeds, `quickfix` runs them on
  the files it changed, without a shell, and the diff, re-score and commit show the result. A
  failing command warns and the run goes on. `jevlint.toml` may set them, so a team can share
  them, but jevlint runs a repository's commands only after you approve them, in a prompt or with
  the new `jevlint trust`; `--yes` never approves them. The approval covers the list, the
  repository's history and the files the commands read, such as a script they name or
  `package.json` and the lockfile for `pnpm`, so a `git pull` that changes one asks again. Each
  command is stopped after its `timeout`, 300 seconds by default. `--json` adds `fixers` and
  `fixerOnly` to each file, and the commit message names the commands that ran and lists the files
  only they changed apart from the agent's.
- **`retry = true` on a `quickfix.after` command.** When the check still fails, the agent gets one
  more run with the command's output, fenced as data, to fix only those errors, and then the
  commands run again. At most one retry per file. `--json` adds `retried`, and the commit message
  names the checks that caused the retry and any that still fail.
- `fix` and `quickfix` no longer claim the working tree is not clean when git fails. Outside a git
  repository, or when git refuses one, as with `detected dubious ownership`, the error now gives
  git's reason. With uncommitted changes, it names the first few files. Changes outside the project
  root, such as in another package of a monorepo, no longer block the run.

## 0.2.5 - 2026-11-09

- **`jevlint quickfix`.** Runs a coding agent on the worst file with the same issues as `prompt`, but
  instructions to only edit files: no tests, builds or other commands, no commits, and one turn or a
  few. It then prints what changed as a git-style diff, coloured in a terminal with the changed words
  highlighted, or as a plain patch that `git apply` accepts when redirected, with a `--stat` style
  summary on stderr. It takes the same flags as `fix`, plus `--json`. Each agent can set a
  `quickfix_command`, and the built-in Claude Code and Codex ones keep the run short. After each
  run it re-audits every changed file and shows its score before and after. In a terminal at least
  120 columns wide the diff is side by side, delta-style, with numbered panels; `--side-by-side`
  and `--no-side-by-side` choose. With `--top`, files run one at a time, labelled `[1/5]` and so on,
  and each diff shows only that run's edits.
  By default it then commits each file's run with `git commit`, one commit per file with the score
  change in its message, and prints the hash. `--no-commit` leaves the changes in the working tree.
  It never commits over changes that were there before the run.
- `audit` suggests `jevlint quickfix <worst file> --agent claude` under its table, beside `explain`
  and `prompt`.
- **`--agent-login` for `fix` and `quickfix`.** Leaves the agent's API key variables, such as
  `ANTHROPIC_API_KEY`, out of its environment, so Claude Code or Codex runs on your subscription
  login instead of a stale key. `use_login = true` makes it the default for an agent, and `key_env`
  names the variables. When an agent fails while such a key is set, the error now says so.

## 0.2.4 - 2026-11-08

- **`jevlint spec`, for spec-driven development.** A spec is a checklist in YAML, kept in
  `.jevlint/spec/`: a project checklist in `index.yaml` and one file per feature. `spec compile`
  prints a prompt that has a coding agent write or update it from your documents. `spec check` routes
  each code file to a feature with one choice question, then judges it against that feature's items,
  and lists the items nothing implements. `spec drift` does the same for documents, and finds
  contradictions, requirements the spec misses, and items no document states. Both list every file or document with its verdict counts, and `--verbose` every item's verdict.
  `accept_uncovered` in `index.yaml` names documents, each with a reason, that may state requirements
  the spec leaves out, such as an index of links.
  With `--copy`, both also copy a prompt that asks a coding agent to fix what they found. `[spec] dir` and
  `docs` in `jevlint.toml` set where the spec and the documents are, and `[spec] threshold` drops
  violations and contradictions the model is less sure of, so false alarms do not push a file up the list. By default the documents are
  `README.md` and the Markdown and HTML files under `docs/`. See
  [Spec-driven development](docs/spec-driven-development.md).
- `AWS_REGION` is now only the default for `cache.region`, so a region set in config, such as
  `"auto"` for R2, wins over it. `JEVLINT_CACHE_REGION` still overrides both.
- `jevlint baseline` and `jevlint architecture --html` print their `Wrote …` line to stderr, like
  every other command, so stdout carries only results.
- In languages without a grammar, the `while` that closes a `do` loop no longer adds complexity.
- The README shows a before-and-after diff of a file jevlint cleaned up, and is now also in
  [Japanese](README.ja.md) and [Simplified Chinese](README.zh-CN.md).

## 0.2.3 - 2026-11-07

- **The default preset is now `full`**, a new built-in that runs every audit preset at once: 97
  questions and all their patterns, in one request per file. Scores, cost and `audit --new` results
  change for any repository that does not set `presets`. Each file sends about 10,000 more tokens: a
  4.6 KB file went from 2,435 to 12,438 billed input tokens on Jev, about $0.0001 to $0.0005.
  `presets = ["readable-code"]` in `jevlint.toml` keeps the old behaviour. A baseline recorded under
  the old default should be recorded again.
- `jevlint init` and `jevlint preset default` list only presets that work in an audit, with `full`
  first, so you choose the default when you set up.
- Presets can name others in `includes`. Each included preset keeps its own question ids and scores.
- On Cloudflare, more than 64 questions no longer stops the run. They are split over several requests,
  each billing the file again, and `--dry-run` counts that.

## 0.2.2 - 2026-11-07

- Presets now work beyond `audit`. `prompt`, `fix`, `explain` and `baseline` take a preset name among
  their arguments or `--preset`, as in `jevlint prompt security --copy`, and `pr`, `commits`, `hook`
  and `test` take `--preset`. `test --record` refuses it, as a record covers every fixture.
- A built-in `bug-hunt` preset: 43 questions, one per defect class from CWE, Orthogonal Defect
  Classification and other taxonomies, plus patterns for JavaScript, TypeScript, Python, Go and Rust
  that need no model. `jevlint audit bug-hunt` ranks the files most likely to hide a bug.
- A stalled network no longer hangs a run. `jevlint pr` gives `gh` 60 seconds and `git fetch` 5
  minutes, and a provider gets 5 minutes per file, after which that file gets a warning.
- `jevlint preset new`, `edit` and `add` no longer overwrite a file that holds a preset of a different
  name, such as `foo.toml` declaring `name = "bar"`. They stop and name the file.
- The remote cache releases its connection after an upload or a miss, instead of holding it until
  garbage collection.

## 0.2.1 - 2026-11-05

- `jevlint pr` no longer needs a number. It finds it from `GITHUB_REF` in a GitHub Actions
  `pull_request` run, and otherwise uses the pull request of the current branch.
- Installing jevlint with pnpm no longer warns "Ignored build scripts: @ast-grep/lang-go, ...". The
  Go, Python and Rust parsers now ship inside the package instead of coming from packages with an
  install script. Analysis is unchanged. On a platform with no prebuilt parser, those languages now
  get approximate metrics instead of an error.
- Two built-in presets: `security` (input validation, injection, secrets in source, access checks,
  safe failure, cryptography, and patterns for `eval`, `innerHTML` and `shell=True`) and
  `documentation` (file purpose, doc comments on exported code, stated contracts, stale doc comments,
  TODOs without a reason).
- `jevlint audit security` picks presets by name for one run, alongside `--preset`. An existing path
  of the same name is still audited as a path, with a note on stderr, and a near miss such as
  `secruity` stops with a suggestion. Unknown preset names everywhere suggest the closest one.
- `jevlint preset` on its own opens a menu: pick a preset, then show, edit, copy or remove it, or make
  it a default. `preset show`, `edit` and `remove` let you pick when the name is left out.
- `jevlint preset default` shows or sets the default presets, in your user config or with `--repo` in
  `jevlint.toml`, keeping the file's comments. `jevlint init --preset` chooses them up front.
- `jevlint preset new` writes a preset, blank or `--from` another, and `jevlint preset edit` opens one
  in `$VISUAL` or `$EDITOR`, copying a built-in first. A save that is not a valid preset is never
  written, and you can edit again. `preset show --toml` prints a preset's file.
- `preset list` and `--help` on `audit`, `init` and `preset` group presets by the command they serve,
  mark the defaults with `*`, and show examples. A new optional `used_by` key in a preset says which
  command it serves.

## 0.2.0 - 2026-11-05

- `--format <text|json|sarif|github>` on `audit`, `pr` and `commits` gives SARIF 2.1.0 for code
  scanning and GitHub Actions annotations. `--json` stays as an alias.
- `jevlint baseline` and `audit --new` record current issues in `.jevlint/baseline.json` and gate only
  on what is new or worse. Exit code 1 now also means new issues with `--new`.
- Semantic rules: `[[rules]]` in a preset or `jevlint.toml` has an ast-grep pattern pick the code and a
  yes/no question judge each match, so model judgements get line numbers, a `fix` for agents and
  caching per match. `max_rule_matches` (default 20, user config only) caps the matches judged per rule
  and file, and `audit --dry-run` and `usage` count rule requests. In `--json`, findings from rules
  carry `probability` and `fix`, and files carry an optional `ruleUsage`.
- `jevlint hook` tells a coding agent what its last edit made worse than `HEAD` (exit 2, findings on
  stderr), and `jevlint hook --staged` does the same for pre-commit (exit 1). Both are AST-only unless
  you pass `--model`. `jevlint init --pre-commit` installs the git hook.
- `jevlint test` proves preset questions against `.jevlint/fixtures/<preset>.<question>/good-*` and
  `bad-*` files, records the results with `--record`, and catches model drift with `--drift`. Exit code
  1 now also means a fixture failed or moved. A directory named `test` must now be audited with
  `jevlint audit test`, and `.jevlint/fixtures/` is never audited.
- `--intent` on `jevlint pr` and `jevlint commits` judges a change against its message and against
  `AGENTS.md` or `CLAUDE.md` from the base commit. It is off by default, and sends the diff, message and
  instructions to your provider.
- jevlint is now a Claude Code plugin, with a skill, `/jevlint:audit`, `/jevlint:explain`,
  `/jevlint:review` and an optional edit hook.
## 0.1.0

- `cache.remote` shares the cache through an S3-compatible bucket, such as AWS S3, Cloudflare R2,
  Google Cloud Storage or MinIO, so CI runs and teammates reuse each other's answers. A missing entry
  is downloaded once and kept locally, and new answers are uploaded as they arrive. With a bucket set,
  `audit --dry-run` contacts it to tell what is cached.
- Files in languages without a grammar, such as Java, Ruby, PHP, C and Lua, now get approximate AST
  metrics from keywords and indentation, with no new dependency. They used to have none. These files
  now count towards AST scores and `fail_under`, so repository scores can change. `--json` marks them
  with `ast.approximate`, and the terminal with `AST ~`.
- More source extensions are audited, including Solidity, COBOL, Fortran, Pascal, Ada, Tcl, Racket,
  Scheme, Lisp, Elm, PureScript, Nix, Haxe, Crystal, GDScript and VHDL. With a model configured, these
  files are now sent to the provider.
- `jevlint pr <number>` reviews what a GitHub pull request changes, and `jevlint commits` does the
  same for commits one by one from `HEAD` backwards. Each shows a file's score before and after, and
  only the findings the change made worse. Neither touches the working tree.
- Initial release: AST and decision-model auditing, presets, caching and coding-agent hand-off.
- `jevlint architecture` reviews the codebase, each directory and each class, using the AST and
  per-perspective model questions, ranks them worst to best, and writes a visual HTML report.
- API keys in environment variables are ignored until you allow them, on the first interactive run
  or with `jevlint auth env on`.
  The question only appears for commands that use a key. An audit with `fail_under` set exits 2 if
  the key was never allowed, rather than gating on AST scores alone.
- An audit with `fail_under` set exits 2 if every provider request failed. With no gate, failures
  stay warnings.
- `init --force` can replace a config too broken to load.
- `architecture` reports files it could not read, in a new `warnings` field in `--json` output.
- `jevlint-score` comments pin a file or question score, and `audit --ignore-pins` reviews them.
- With no key for the configured provider, a run uses another provider that has one, and says so.
  `audit --dry-run` names the provider that would really be used.
- Only files with a known source extension are audited, so tool dotfiles such as `.node-version`
  no longer appear in reports. Extensionless scripts, `Dockerfile` and `Makefile` are no longer read.
- `audit`, `architecture`, `fix`, `prompt` and `explain` warn when run across the home directory or
  over more than `warn_file_count` files (default 1,000).
- `audit --dry-run`, `audit` and `architecture` show a rough USD cost. The dry-run token estimate now
  includes preset questions and leaves out cached files, and `--json` adds `skipped` and
  `estimatedCostUsd`. `usage` in the JSON reports adds `estimatedCostUsd`.

### Security

- Node.js must have the fixes of October 2026, such as CVE-2026-111497: 22.23.4, 24.22.1 or 26.12.1
  on those lines. jevlint refuses to run on anything older, and on end-of-life lines such as 25.x.
- Terminal output, error messages and the progress line replace control characters with `?`, so a
  hostile file name, preset or provider message cannot drive the terminal.
- `include` patterns can no longer reach outside the root through a symlinked directory.
- `git log` no longer runs a `gpg.program` or `remote.<name>.uploadpack` set in a repository's
  `.git/config`.
- `preset add --repo` no longer writes through symlinks, and repository presets must resolve inside
  the repository. A link that leads outside is an error.
- Architecture outlines no longer carry literals from top-level destructuring.
- A long run of spaces in a `jevlint-score` comment no longer stalls an audit.
- `architecture --html` and `init` no longer write through a symlink planted at their destination.
- A bare repository committed inside a clone is no longer used, so `fix` cannot run its `fsmonitor`.
- A repository that names another provider no longer inherits your `base_url`, which would have sent
  that provider's key to your endpoint. Set `name` beside `base_url` in your user config.
- A `jevlint.toml` or `go.mod` linked to a device or pipe is refused rather than read forever.
- `.gitignore` files above a `jevlint.toml` in a subdirectory now apply, so ignored secrets stay out.
- File names and preset text can no longer add lines to the prompt given to a coding agent.
- `prompt` and `config show` output no longer carry terminal escape sequences, and bidirectional
  overrides in file names are neutralised everywhere.

### Changed

- `audit` exits 2 when `fail_under` is set and no file was scored, instead of passing on nothing.
- `base_url` is part of the cache key, so users of a custom endpoint re-send each file once.
- `--top` in `prompt` and `fix` counts only files with issues, and is checked before the audit.
- `explain <directory>` is refused before any file is audited or sent.
- `architecture --html` needs a file name, and no longer takes the next flag as one.
- `scoring.precision` is limited to 100, and `ast_weight` and `model_weight` cannot both be 0.
- `audit --dry-run` leaves out blank files, which are never sent.
- `preset add` replaces a symlink at the destination rather than updating its target.

### Fixed

- A file with a very deep expression no longer aborts the audit, and analysing such a file is faster.
- An unreadable file gives a warning in `audit` and is left out by `architecture`, instead of ending
  the run.
- A cache that cannot be written, or holds a malformed entry, no longer loses a model answer.
- `fix` reports a file the agent deleted as `removed`, and its clean check sees untracked files even
  with `status.showUntrackedFiles=no`.
- Complexity counts a loop, `switch` or ternary that directly follows `else`.
- Parameter counts skip receivers by language: `self: T`, `mut self: Box<Self>` and TypeScript
  `this: T`, but not a JavaScript parameter that is merely named `self`. Rust attributes no longer
  count.
- Go function literals and JavaScript class-field functions are named in findings.
- The repository score counts whole-file pins in languages without AST support.
- Identical files audited in the same run share one provider call.
- A preset listed twice is loaded once, so its questions no longer count double.
- `architecture` shows a Warnings section in the terminal and HTML reports, and marks directory and
  class boxes for cycles and findings.
- `architecture` no longer overflows the stack on long dependency chains, and counts base classes,
  non-ASCII class names, multi-name declarations and `import x = require()` correctly.
- `architecture` resolves directory imports with a trailing slash or at the root, Go packages to
  `.go` files only, and Rust crate roots under a directory whose name ends in `src`.
- Names of `Object.prototype` members, such as `constructor`, are rejected as commands and agents.
- `init` stops at the first cancelled prompt.
- A failed `--html` write or `prompt --copy` is reported as a user error.
- A terminal reporting 0 columns is treated like a pipe.
