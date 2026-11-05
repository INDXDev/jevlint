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
                  ├─ report.ts     terminal output
                  ├─ formats.ts    SARIF and workflow commands
                  ├─ prompt.ts     agent prompt
                  └─ agent.ts      run an agent
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
│   ├── architecture/    Structure review: extraction, graphs and views
│   └── *.ts             Core modules, listed below
├── presets/             Built-in presets, as TOML
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
| `src/architecture/` | It reviews structure across files | Per-file metrics |
| `presets/` | It is a principle or a question | Code of any kind |
| `test/` | It verifies behaviour without a real provider | Real API calls |

## Layers

Dependencies point downward only. A module never imports from a layer above it.

| Layer | Modules | May use |
| --- | --- | --- |
| Interface | `cli.ts`, `commands/`, `report.ts`, `formats.ts`, `prompt.ts`, `agent.ts`, `architecture/terminal.ts`, `architecture/html.ts` | Everything below |
| Pipeline | `audit.ts`, `rules.ts`, `review.ts`, `baseline.ts`, `hook.ts`, `intent.ts`, `fixtures.ts`, `architecture/review.ts` | Everything below |
| Engines | `ast/`, `decision/`, `scoring.ts`, `architecture/extract.ts`, `resolve.ts`, `graph.ts`, `structure.ts`, `outline.ts` | Infrastructure, contracts |
| Infrastructure | `config.ts`, `credentials.ts`, `presets.ts`, `files.ts`, `directives.ts`, `cache.ts`, `remote-cache.ts`, `git.ts`, `node-version.ts` | Contracts |
| Contracts | `types.ts` | Nothing |

Modules in the same layer may import each other, as `ast/analyze.ts` does with `scoring.ts`.

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
| `src/architecture/terminal.ts`, `html.ts` | Render the report |
| `src/directives.ts` | Parses `jevlint-score` comments and removes them from the sent code |
| `src/cache.ts` | Content-addressed storage on disk |
| `src/remote-cache.ts` | Puts an optional S3-compatible bucket behind the disk cache |
| `src/review.ts` | Audits a change's files on both sides, in temporary snapshots, and compares them |
| `src/baseline.ts` | Writes and reads `.jevlint/baseline.json`, and narrows a report to what is new |
| `src/hook.ts` | Finds the file an edit touched and installs the pre-commit hook |
| `src/intent.ts` | Builds one state from a change's message, base-commit instructions and diff, and asks `change-intent` |
| `src/fixtures.ts` | Reads `.jevlint/fixtures`, asks each fixture its question, and writes or compares `calibration.json` |
| `src/git.ts` | Churn, working-tree status, and reading changes, diffs, commits and pull requests |
| `src/node-version.ts` | Decides whether this Node.js has the required security fixes |
| `src/scoring.ts` | Pure functions from the [scoring formulas](scoring.md) |
| `src/audit.ts` | Runs the pipeline and returns an `AuditReport` |
| `src/rules.ts` | Judges each semantic rule match with one boolean question, and adds hits to the AST findings |
| `src/report.ts` | Formats reports for the terminal |
| `src/formats.ts` | Renders findings as SARIF and GitHub workflow commands |
| `src/prompt.ts` | Renders fix prompts |
| `src/agent.ts` | Resolves and runs an agent, then re-scores the file |
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

## Dependencies

| Package | Purpose |
| --- | --- |
| `ai`, `@ai-sdk/*` | Decision models |
| `@ast-grep/napi` | Parsing. Grammars from `@ast-grep/lang-*` are copied into the build |
| `citty` | Command parsing |
| `@clack/prompts` | Interactive prompts |
| `picocolors` | Colour |
| `smol-toml` | TOML |
| `zod` | Config and preset validation |
| `tinyglobby`, `ignore` | File discovery |
| `p-limit` | Concurrency |
| `clipboardy` | Clipboard |

Development uses TypeScript, tsdown, Vitest and Biome.
