# Architecture

jevlint is a linear pipeline with small modules. Commands are thin, and `audit()` does the work.

```
              config.ts ── presets.ts ── credentials.ts
                  │
cli.ts ── commands/* ── audit.ts ─┬─ files.ts          discover
                  │               ├─ ast/              metrics
                  │               ├─ decision/ ─ remote-cache.ts ─ cache.ts   model answers
                  │               ├─ rules.ts          judge pattern matches
                  │               ├─ git.ts            churn
                  │               └─ scoring.ts        score and rank
                  ├─ review.ts     audit both sides of a change
                  ├─ baseline.ts   compare an audit to a recorded one
                  ├─ intent.ts     judge a change against its message
                  ├─ fixtures.ts   test questions on known files
                  ├─ spec/         check code and documents against a spec
                  ├─ report.ts     terminal output
                  ├─ formats.ts    SARIF and workflow commands
                  ├─ prompt.ts     agent prompt
                  ├─ agent.ts      run an agent
                  ├─ diff.ts       diff what an agent changed
                  └─ diff-view.ts  draw it, unified or side by side
```

## Folder structure

```
jevlint/
├── src/
│   ├── cli.ts           Entry point: command table and exit codes
│   ├── index.ts         Public library API
│   ├── types.ts         Contracts shared between modules
│   ├── commands/        One file per CLI command
│   ├── ast/             Local code metrics
│   ├── decision/        Everything that talks to a decision model
│   ├── architecture/    Structure review and the architecture SSOT: facts, graphs, rules and views
│   ├── spec/            Spec-driven development: load, check, drift and their output
│   └── *.ts             Core modules, listed below
├── presets/             Built-in presets, as TOML
├── .jevlint/            jevlint's own spec and architecture SSOT
├── examples/messy-shop/ A deliberately messy project for demos
├── .claude-plugin/      Claude Code plugin manifests, with commands/, hooks/ and skills/ beside
│                        them. The plugin installs from git and does not ship to npm
├── test/                Vitest tests, named after the module they cover
└── docs/                User and contributor documentation
```

| Folder | Put code here when | Keep out |
| --- | --- | --- |
| `src/commands/` | It parses flags or prints for one command | Business logic |
| `src/ast/` | It measures source code without a network | Scoring, I/O |
| `src/decision/` | It depends on the AI SDK or a provider | Scoring, file discovery |
| `src/architecture/` | It reviews structure across files, or reads, checks or renders the SSOT | Per-file metrics, terminal output outside `terminal.ts` |
| `src/spec/` | It reads a spec or judges code or documents against one | Terminal output outside `prompt.ts` and `terminal.ts` |
| `presets/` | It is a principle or a question | Code of any kind |
| `test/` | It verifies behaviour without a real provider | Real API calls |

## Layers

Dependencies point downward only. A module never imports from a layer above it.

| Layer | Modules | May use |
| --- | --- | --- |
| Interface | `cli.ts`, `commands/`, `index.ts`, `report.ts`, `formats.ts`, `prompt.ts`, `diff-view.ts`, `architecture/terminal.ts`, `html.ts`, `markdown.ts`, `prompt.ts`, `spec/prompt.ts`, `spec/terminal.ts` | Everything below |
| Pipeline | `audit.ts`, `rules.ts`, `review.ts`, `baseline.ts`, `hook.ts`, `intent.ts`, `acceptance.ts`, `fixtures.ts`, `agent.ts`, `diff.ts`, `architecture/collect.ts`, `review.ts`, `check.ts`, `drift.ts`, `compile.ts`, `plan.ts`, `show.ts`, `spec/check.ts`, `spec/drift.ts`, `spec/run.ts` | Everything below |
| Engines | `ast/`, `decision/`, `scoring.ts`, `architecture/extract.ts`, `resolve.ts`, `graph.ts`, `structure.ts`, `outline.ts`, `facts.ts`, `externals.ts`, `entrypoints.ts`, `conformance.ts`, `questions.ts`, `draft.ts`, `views.ts`, `workspace.ts`, `spec/questions.ts` | Infrastructure, contracts |
| Infrastructure | `config.ts`, `credentials.ts`, `presets.ts`, `files.ts`, `directives.ts`, `cache.ts`, `remote-cache.ts`, `git.ts`, `fixers.ts`, `trust.ts`, `node-version.ts`, `spec/load.ts`, `architecture/load.ts` | Contracts |
| Contracts | `types.ts` | Nothing |

Modules in the same layer may import each other, as `ast/analyze.ts` does with `scoring.ts`.

jevlint's own [architecture SSOT](architecture-reference.md) in `.jevlint/architecture/` states these
layers and the three rules below as structural rules, so `jevlint architecture check --static`
decides them from the import graph with no network.

Three rules keep these layers clean:

- **`scoring.ts` stays pure.** It performs no I/O, so every formula can be tested with plain values.
- **Only `src/decision/` imports the AI SDK.** Its decision API is experimental, so a breaking
  change must stay in one folder.
- **Only the interface layer writes to the terminal.** Core modules return data or throw
  `UserError`, which also keeps the library API silent.

## Code conventions

- Prefer plain functions and data. Use a class only for an error type, which needs `instanceof`.
- Keep config keys in `snake_case`, exactly as written in TOML, so no mapping layer is needed.
- Throw `UserError` for anything the user can fix. Any other error is a bug.
- Give every exported symbol a short doc comment that says what it is for. Inline comments explain
  why, never what.
- Name a file after what it does, and split it when it does two things.

## Modules

| Module | Responsibility |
| --- | --- |
| `src/cli.ts` | Declares commands and maps errors to exit codes |
| `src/commands/` | One file per command, except `review.ts`, which holds `pr` and `commits`. Parses flags and calls core modules |
| `src/commands/shared.ts` | Flag parsing and the audit flow that commands share |
| `src/config.ts` | Paths, schema, layered loading, repository restrictions |
| `src/credentials.ts` | Reads and writes API keys |
| `src/presets.ts` | Loads and validates presets from all sources |
| `src/files.ts` | File discovery and exclusions |
| `src/ast/languages.ts` | Maps languages to ast-grep and their node kinds |
| `src/ast/analyze.ts` | Language-independent metrics |
| `src/ast/generic.ts` | Approximate metrics for files with no grammar |
| `src/decision/providers.ts` | Creates a decision model from config |
| `src/decision/decide.ts` | Sends one file's questions and uses the cache |
| `src/decision/pricing.ts` | Estimates what input tokens cost |
| `src/architecture/extract.ts` | Reads a file's imports, top-level names and classes |
| `src/architecture/resolve.ts` | Turns import specifiers into repository paths |
| `src/architecture/graph.ts` | Pure graph algorithms: cycles and layers |
| `src/architecture/structure.ts` | Builds the three graphs and their findings |
| `src/architecture/outline.ts` | Lists the units to review, with the outline each sends to a model |
| `src/architecture/review.ts` | Runs the review and returns an `ArchitectureReport` |
| `src/architecture/facts.ts` | Proposes component candidates, layers, interfaces, flows and co-changes from the resolved modules |
| `src/architecture/externals.ts`, `entrypoints.ts` | Tables of known external systems and of entry-point patterns |
| `src/architecture/workspace.ts` | Reads `go.mod`, the root `tsconfig.json`'s `paths` and workspace manifests for resolution |
| `src/architecture/collect.ts` | Reads the working tree or a commit into outlines, cached by content hash, and builds the facts |
| `src/architecture/load.ts` | Reads and validates the architecture SSOT, and its size budget |
| `src/architecture/conformance.ts` | Decides the SSOT's structural rules, lays real dependencies over declared ones, and finds static drift |
| `src/architecture/draft.ts` | Turns the facts into a draft SSOT |
| `src/architecture/questions.ts` | The check, drift and review questions and outlines, as pure data |
| `src/architecture/views.ts` | Checks views and chapters against the code: arrows against imports, citations against files |
| `src/architecture/check.ts`, `drift.ts`, `compile.ts`, `plan.ts`, `show.ts` | Run each SSOT verb |
| `src/architecture/terminal.ts`, `html.ts`, `markdown.ts`, `prompt.ts` | Render the reports, the SSOT as ARCHITECTURE.md, and the agent prompts |
| `src/directives.ts` | Parses `jevlint-score` comments and removes them from the sent code |
| `src/cache.ts` | Content-addressed storage on disk |
| `src/remote-cache.ts` | Puts an optional S3-compatible bucket behind the disk cache |
| `src/review.ts` | Audits a change's files on both sides, in temporary snapshots, and compares them |
| `src/baseline.ts` | Writes and reads `.jevlint/baseline.json`, and narrows a report to what is new |
| `src/hook.ts` | Finds the file an edit touched and installs the pre-commit hook |
| `src/intent.ts` | Builds one state from a change's message, base-commit instructions and diff, and asks `change-intent` |
| `src/acceptance.ts` | Cuts a pull request's body and the issues it closes into chunks, asks `acceptance-criteria` of each, and judges the diff against the criteria |
| `src/fixtures.ts` | Reads `.jevlint/fixtures`, asks each fixture its question, and writes or compares `calibration.json` |
| `src/git.ts` | Churn, working-tree status, and reading changes, diffs, commits and pull requests |
| `src/fixers.ts` | Runs the `quickfix.after` commands on the files they match, without a shell and with a timeout |
| `src/trust.ts` | Records which repositories' `quickfix.after` commands the user approved, in the user's config directory |
| `src/node-version.ts` | Decides whether this Node.js has the required security fixes |
| `src/spec/load.ts` | Reads and validates the spec YAML in `spec.dir` |
| `src/spec/questions.ts` | Builds the routing, item and coverage questions, as pure data |
| `src/spec/check.ts`, `drift.ts` | Judge code files and documents against the spec in two requests each |
| `src/spec/run.ts` | The model, the per-path loop and verdicts that spec and architecture checks share |
| `src/spec/prompt.ts`, `terminal.ts` | Render the compile prompt and the reports |
| `src/scoring.ts` | Pure functions from the [scoring formulas](scoring.md) |
| `src/audit.ts` | Runs the pipeline and returns an `AuditReport` |
| `src/rules.ts` | Judges each semantic rule match with one boolean question, and adds hits to the AST findings |
| `src/report.ts` | Formats reports for the terminal |
| `src/formats.ts` | Renders findings as SARIF and GitHub workflow commands |
| `src/prompt.ts` | Renders fix prompts, and the quick fix's retry prompt with a failing check's output |
| `src/agent.ts` | Resolves and runs an agent with a prompt its command rendered, then the project's `quickfix.after` commands and the one retry, collects what they changed, and re-scores the files |
| `src/diff.ts` | Turns contents before and after into git-style patches |
| `src/diff-view.ts` | Draws patches for a terminal, unified or side by side, with changed words highlighted, and the summary with scores |
| `src/types.ts` | Contracts shared between modules |
| `presets/*.toml` | Built-in presets, as data rather than code |

## Design decisions

**The AI SDK is the provider layer.** Its decision API already handles the protocol, retries and
validation. We add only a `fetch` shim for Cloudflare's envelope. The API is experimental, so all
use of it stays in `src/decision/`.

**One Jev-protocol path.** Cloudflare, Microsoft and generic endpoints reuse the TypeSafe provider
with a different base URL.

**ast-grep for every language.** One tree-sitter-based API lets a language be a table of node kinds
rather than a new analyser.

**A lexical fallback rather than more grammars.** Each `@ast-grep/lang-*` package is about 11 MB of
prebuilt parsers, so the default install keeps only the grammars it has. Every other language gets
`src/ast/generic.ts`, which needs no dependency. It reads keywords and indentation, runs in one pass
because the file is hostile, and stays silent when it cannot place code in a function.

**Grammars ship as files, not dependencies.** Each `@ast-grep/lang-*` package has an install script
that only builds a parser where no prebuilt one exists, and pnpm warns about every such script. So
they are devDependencies, the build copies their prebuilt parsers and licenses into `dist/parsers/`,
and `src/ast/languages.ts` registers them from there, or from `node_modules` when running from
source. On a platform with no prebuilt parser, that language gets the lexical fallback.

**The cache bucket is plain signed HTTP.** `src/remote-cache.ts` signs its GET and PUT with SigV4 from
`node:crypto`, which every S3-compatible store accepts, so no SDK is needed.

**Presets are data.** New principles need no code, and users get the same power as maintainers.

**Scoring is pure and runs after the cache.** Only raw answers are cached, so tuning weights is free.

**`quickfix` diffs in JavaScript, not with `git diff`.** A repository's config can make `git diff`
run external diff and textconv programs, and jsdiff writes git-style patches that `git apply` takes.
Git only finds which files changed. Drawing is separate from the patch, in `diff-view.ts`, so a
redirected run gets the plain patch, and the side-by-side view reuses its hunks. That view is drawn
in the style of delta, but built in, so no external pager runs on repository text.

**`prompt`, `fix` and `explain` re-run `audit()`.** The cache makes this cheap, and it removes stale
state and a separate report store.

**The repository is untrusted input.** The schema for `jevlint.toml` is stricter than the user
schema. See [Security and privacy](security.md).

**Pins are removed before the model sees the code.** Model scores shift on trivial edits, so a
comment must not change the score it is fixing, or invalidate the cache.

**A semantic rule's hit is an AST finding.** A rule becomes a one-question `decideFile` call with the
match as its state, so the cache and every provider work unchanged, and thresholds apply after the
cache. As a finding, a hit needs no code in ranking, `explain`, `prompt`, `pr` or `commits`. Matches
come from the raw source so that lines stay true, and pins are removed from each match. Matches in a
file are asked one at a time, which keeps `concurrency` the limit for the whole run.

**The architecture review sends outlines, not code.** A unit's names and dependencies fit in a small
request and answer questions about design better than file contents would. Each perspective has its
own preset, because a question that fits a directory does not fit a class. It reuses
`decideFile`, so the cache and every provider work unchanged.

**`--intent` is one request about a change, not a file.** It builds a single state string and calls
`decideFile`, as the architecture review does, so the cache and every provider work unchanged. The
message goes before the diff because `max_file_chars` cuts from the end.

**A spec is judged in two requests per file.** The first asks one choice question, which feature
the file belongs to, together with the project checklist. The second asks only that feature's items.
This keeps each request small and every question relevant. Both go through `decideState`, the
general form of `decideFile` that also takes choice questions, so the cache and every provider work
unchanged. jevlint never writes the spec: `spec compile` hands that judgement to a coding agent, and
the YAML is the single source of truth that both other commands read.

**`--acceptance` extracts, then judges.** A fixed boolean question about one short chunk of a pull
request or issue, "is this a criterion?", is cheap, cached per chunk and testable with fixtures,
which a question written per chunk would not be. Judging then runs only against criteria, so
background, discussion and out-of-scope lists do not become failures. The chunker is line-based,
with no Markdown parser, because the text is hostile and GitHub bodies are simple.

## Dependencies

| Package | Purpose |
| --- | --- |
| `ai`, `@ai-sdk/*` | Decision models |
| `@ast-grep/napi` | Parsing. Grammars from `@ast-grep/lang-*` are copied into the build |
| `citty` | Command parsing |
| `@clack/prompts` | Interactive prompts |
| `picocolors` | Colour |
| `smol-toml` | TOML |
| `yaml` | Spec files |
| `zod` | Config and preset validation |
| `tinyglobby`, `ignore` | File discovery |
| `p-limit` | Concurrency |
| `clipboardy` | Clipboard |
| `diff` | Line and word diffs for `quickfix` |

Development uses TypeScript, tsdown, Vitest and Biome.
