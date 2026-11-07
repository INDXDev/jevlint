# Code reference

A map of the types and functions you meet when working on jevlint. Each exported symbol also has a
doc comment in the source, which is the authority on details. For how the pieces fit together, read
[Architecture](architecture.md).

## Classes

jevlint uses plain functions and data. It has one class of its own.

### `UserError`

Defined in `src/config.ts`. Marks a problem the user can fix, such as a bad config value or a missing
file. `src/cli.ts` prints its message to stderr without a stack trace and exits with code 2. Any other error
is treated as a bug.

```ts
throw new UserError('Path not found: src/nope.ts');
```

## Core types

Shared contracts live in `src/types.ts`.

| Type | Describes |
| --- | --- |
| `Language` | A language with AST support |
| `ProviderName` | A configured provider, such as `typesafe` |
| `Question` | One preset question: `ScoreQuestion` or `BooleanQuestion` |
| `Preset` | A named set of questions, AST patterns and semantic rules |
| `AstPattern` | An ast-grep pattern with an id and message |
| `AstRule` | An `AstPattern` whose matches a boolean question judges |
| `Pin` | A score fixed by a `jevlint-score` comment |
| `AstFinding` | One measured problem, with a line number |
| `AstResult` | A file's AST score and findings |
| `RawAnswer` | A model's number for one question, as stored in the cache |
| `ModelAnswer` | One question's result after conversion to compliance |
| `ModelResult` | A file's model score and answers |
| `FileReport` | Everything known about one file |
| `AuditReport` | The result of an audit, as printed by `--json` |
| `Change`, `ChangedFile`, `ChangeReview` | Two commits to compare, how they moved one file, and the result of `pr` or `commits` |
| `ArchitectureReport` | The result of a structure review, as printed by `--json` |
| `ArchitectureUnit`, `Perspective` | One reviewed thing, and the level it belongs to |
| `DirectoryNode`, `ModuleNode`, `ClassNode` | Nodes of the graphs |
| `ArchitectureEdge` | One dependency in a graph |
| `ArchitectureFinding` | A structural problem and the directories it counts against |

`Config` lives in `src/config.ts`, because it is inferred from the validation schema. Its keys stay
in `snake_case` to match TOML.

Other module-level types:

| Type | Module | Describes |
| --- | --- | --- |
| `AuditOptions` | `audit.ts` | Options for one `audit()` call |
| `AuditPlan` | `audit.ts` | What a dry run would send |
| `ResolvedModel` | `decision/providers.ts` | A ready model with its provider and id |
| `DecideFileOptions` | `decision/decide.ts` | Input for deciding one file |
| `Decision` | `scoring.ts` | Answers and metadata for one file, as scoring receives them |
| `LanguageSpec` | `ast/languages.ts` | Node kinds that describe one language |
| `Directives` | `directives.ts` | A file's pins, warnings and code without directive lines |
| `S3Credentials` | `remote-cache.ts` | The keys that sign a bucket request |
| `ModuleOutline`, `ClassOutline` | `architecture/extract.ts` | What a file imports and declares |
| `Structure` | `architecture/structure.ts` | The graphs and findings before scoring |
| `Subject` | `architecture/outline.ts` | A unit before scoring, with its outline |

## Data flow

Each stage turns one type into the next:

```
Config ─ discoverFiles ─► paths
source ─ analyzeAst ─► AstResult ─────────────┐
source ─ decideFile ─► RawAnswer ─ modelResult ─► ModelResult ─ fileScore ─► FileReport
FileReport[] ─ rank ─► AuditReport ─ formatReport ─► terminal
                                   └ renderPrompt ─► coding agent
```

## Key functions

### Pipeline: `src/audit.ts`

| Function | Purpose |
| --- | --- |
| `audit(config, options)` | Runs the whole pipeline and returns an `AuditReport` |
| `planAudit(config, options)` | Lists files and estimates tokens with no provider requests |

### Change review: `src/review.ts`

| Function | Purpose |
| --- | --- |
| `reviewChange(config, change, options)` | Audits a change's files on both sides and returns a `ChangeReview` |
| `worseFindings(after, before)` | Keeps the findings a change introduced or made worse |
| `worseAnswers(after, before)` | Keeps the weak answers a change lowered |

### Baseline: `src/baseline.ts`

| Function | Purpose |
| --- | --- |
| `toBaseline(report)` | Reduces an audit to what a baseline records |
| `writeBaseline(root, baseline)`, `readBaseline(root)` | Store it in `.jevlint/baseline.json` |
| `newIssues(report, baseline)` | Narrows a report to what is new or worse |

### Change intent: `src/intent.ts`

| Function | Purpose |
| --- | --- |
| `judgeIntent(config, change, noCache)` | Asks `change-intent` about one change. Returns null with no key |

### Fixtures: `src/fixtures.ts`

| Function | Purpose |
| --- | --- |
| `testFixtures(config, options)` | Asks each fixture its question, then records the results or compares them with the record |

### Architecture: `src/architecture/`

| Function | Module | Purpose |
| --- | --- | --- |
| `reviewArchitecture(config, options)` | `review.ts` | Runs the whole review and returns an `ArchitectureReport` |
| `extractModule(path, source, language)` | `extract.ts` | Outlines one file |
| `resolveImport(specifier, from, language, context)` | `resolve.ts` | Finds the repository file an import points to |
| `stronglyConnected`, `layersOf`, `cyclicNodes` | `graph.ts` | Find cycles and layers |
| `buildStructure(files, limits)` | `structure.ts` | Builds the graphs and findings |
| `subjectsOf(structure)` | `outline.ts` | Lists the units to review |
| `formatArchitecture`, `renderArchitectureHtml` | `terminal.ts`, `html.ts` | Render the report |

### Config: `src/config.ts`

| Function | Purpose |
| --- | --- |
| `loadConfig({ cwd, overrides })` | Finds the root and merges every config layer |
| `renderConfigToml(config)` | Formats the merged config for `config show` |
| `paths` | Locations of user config, credentials and presets |

### Presets: `src/presets.ts`

| Function | Purpose |
| --- | --- |
| `loadPresets(names, root)` | Resolves names in repository, user, built-in order |
| `activeQuestions(presets, weights)` | Applies weights and produces full `<preset>.<id>` ids |
| `parsePreset(toml)` | Validates a preset |
| `listPresets`, `installPreset`, `removePreset`, `createPreset`, `editablePreset` | Back the `preset` command |
| `presetsInArgs(args, { root, cwd })` | Sorts `audit` arguments into presets and paths |
| `closestName(name, names)` | The name a typo most likely meant, for suggestions |

### Engines

| Function | Module | Purpose |
| --- | --- | --- |
| `languageOf(path)` | `ast/languages.ts` | Maps a file extension to a `Language` |
| `analyzeAst(source, language, limits, patterns)` | `ast/analyze.ts` | Measures one file |
| `analyzeGeneric(source, limits)` | `ast/generic.ts` | Approximates the same metrics with no grammar, or `null` if it finds no function |
| `createDecisionModel(config)` | `decision/providers.ts` | Builds a model, or `null` with no key |
| `decideFile(options)` | `decision/decide.ts` | Gets answers for one file, using the cache |
| `isDecisionCached(target, questions, source, config)` | `decision/decide.ts` | Tells a dry run whether `decideFile` would use the cache |
| `estimateCostUsd` | `decision/pricing.ts` | Prices input tokens, or `null` if the model's price is unknown |

### Scoring: `src/scoring.ts`

All of these are pure and implement [Scoring](scoring.md).

| Function | Purpose |
| --- | --- |
| `compliance(question, answer)` | Converts a raw answer to a value from 0 to 1 |
| `astScoreFrom(findings)` | Computes the AST score |
| `modelResult(...)` | Combines answers into a `ModelResult` |
| `fileScore(...)` | Combines the two engines |
| `rank(...)` | Applies priority and sorts |
| `repoScore(...)` | Computes the line-weighted repository score |
| `scaleScore(...)` | Converts 0 to 1 onto the configured scale |

### Infrastructure

| Function | Module | Purpose |
| --- | --- | --- |
| `discoverFiles(config, paths)` | `files.ts` | Lists auditable files |
| `parseDirectives(source, scale)` | `directives.ts` | Reads `jevlint-score` comments |
| `getApiKey(provider)` | `credentials.ts` | Reads a key from the environment if allowed, then the file |
| `setApiKey`, `removeApiKey`, `keySource`, `envKeysAllowed`, `setEnvKeysAllowed` | `credentials.ts` | Back the `auth` command |
| `cacheKey`, `readCache`, `writeCache` | `cache.ts` | Content-addressed storage |
| `cacheInfo`, `clearCache` | `cache.ts` | Back the `cache` command |
| `readThrough`, `writeThrough` | `remote-cache.ts` | Use the disk cache, with the bucket behind it |
| `commitCounts(root, days)` | `git.ts` | Measures churn |
| `isClean(root)` | `git.ts` | Checks the working tree |
| `changedFiles`, `fileAt`, `commitsFrom`, `pullRequestChange` | `git.ts` | Read changes for `pr` and `commits` |
| `isPatchedNode(version)` | `node-version.ts` | Checks Node.js against the security floor |

### Interface

| Function | Module | Purpose |
| --- | --- | --- |
| `formatReport`, `formatExplain`, `formatPlan`, `formatReview` | `report.ts` | Render terminal output |
| `auditIssues`, `reviewIssues`, `formatSarif`, `formatGithub`, `formatIssues` | `formats.ts` | Render `--format sarif` and `github` |
| `renderPrompt(files, report)` | `prompt.ts` | Builds the Markdown fix prompt |
| `resolveAgent`, `runAgent`, `fixFile` | `agent.ts` | Find, run and verify a coding agent |
| `auditProject`, `selectFiles`, `resolvePaths`, `parseFormat` | `commands/shared.ts` | Flow shared by commands |

Each command exports one citty definition, such as `auditCommand`, which `src/cli.ts` registers.

## Library API

`src/index.ts` is the public surface: `audit`, `reviewArchitecture`, `loadConfig` and the types in `src/types.ts`. Anything
else is internal and may change. See [Library API](extending.md#library-api).
