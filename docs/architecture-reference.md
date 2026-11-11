# Architecture SSOT reference

The architecture SSOT (single source of truth) is a small set of YAML files that describes a
repository's components, layers and rules. jevlint checks the code against it, and people and coding
agents read it before the code. This page is the exact format and what each command does with it.
The guide is [Architecture-driven development](architecture-driven-development.md).

## Location

```
.jevlint/architecture/
├── index.yaml              the system: description, layers, externals, rules, checklist
├── components/
│   ├── decision.yaml       one component each, named after its id
│   └── scoring.yaml
├── flows/
│   └── audit.yaml          one main workflow each (optional)
├── views/
│   ├── context.yaml        curated diagrams for people (optional)
│   ├── overview.yaml
│   └── data-model.yaml
└── chapters/
    ├── 10-overview.md      the prose of the document, in file name order (optional)
    └── 20-principles.md
```

The YAML structure is what jevlint checks the code against. Views and chapters are the document
people and coding agents read: `show --markdown` builds an ARCHITECTURE.md from all of it.

Set [`architecture.dir`](configuration.md#architecture-limits) to move it. It must stay inside the
root. Commit the directory.

## `index.yaml`

```yaml
version: 1
name: jevlint
compiled_at: e6b0947
description: >
  A model-based linter CLI. Commands stay thin; pipelines call engines, which call infrastructure.
  Only src/decision/ talks to model providers.
layers: [interface, pipeline, engines, infrastructure, contracts]
ignore: ["tsdown.config.ts"]
externals:
  - id: ai_sdk
    title: AI SDK
    packages: ["ai", "@ai-sdk/*"]
rules:
  - { id: layers-point-down, kind: layers }
  - { id: no-component-cycles, kind: no-cycles }
  - { id: ai-sdk-in-decision, kind: only, externals: [ai_sdk], components: [decision] }
  - { id: terminal-only-interface, kind: forbid-call, pattern: "console.$M($$$)", except: [cli] }
checklist:
  - id: user-error
    text: "A problem the user can fix is thrown as UserError; any other error is a bug."
```

| Key | Type | Required | Meaning |
| --- | --- | --- | --- |
| `version` | `1` | Yes | The format version |
| `name` | string | Yes | The system's name |
| `compiled_at` | commit hash | No | The commit the SSOT was compiled from: the base of `drift` and of an update |
| `description` | string | Yes | What the system does and how it is shaped, in a paragraph |
| `layers` | list of ids | No | Layer names, top to bottom |
| `ignore` | list of globs | No | Files that belong to no component on purpose, such as tests and build config |
| `externals` | list | No | External systems: `id`, `title`, `packages`, optional `summary` |
| `rules` | list of [rules](#rules) | No | Structural rules for the whole system |
| `checklist` | list of items | No | Prose rules a decision model judges against every file |

## `components/<id>.yaml`

```yaml
id: decision
title: Decision models
summary: >
  Sends questions to a decision model provider through the AI SDK and caches raw answers by content.
  Every other part reaches models through here.
layer: engines
paths: ["src/decision/**"]
key_files:
  - { path: src/decision/decide.ts, role: "decideFile, decideState and the cache key" }
  - { path: src/decision/providers.ts, role: "creates a model from config" }
interface: [decideFile, decideState, createDecisionModel]
depends_on: [config, cache, contracts]
uses: [ai_sdk]
rules:
  - { id: owns-ai-sdk, kind: only, externals: [ai_sdk] }
checklist:
  - id: cache-key
    text: "A cache key covers provider, model, endpoint, questions and content."
status: current
```

| Key | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | id | Yes | Equal to the file name without `.yaml`. `global` is reserved |
| `title` | string | Yes | A short name |
| `summary` | string | Yes | One to three sentences: what it does and for whom |
| `layer` | layer id | No | One of `index.yaml`'s `layers` |
| `paths` | list of globs | Yes | The files it owns. A file belongs to the component with the most specific matching glob |
| `key_files` | list | No | Where to start reading, each with `path` and `role` |
| `interface` | list of names | No | What other components use |
| `depends_on` | list of ids | No | The only components it may import. When absent, any |
| `uses` | list of external ids | No | The external systems it imports |
| `rules` | list of [rules](#rules) | No | Rules that apply to this component's files |
| `checklist` | list of items | No | Prose rules judged against this component's files |
| `status` | `current` or `target` | No | `target` marks the intended shape: its violations are known debt. Default `current` |

## `flows/<id>.yaml`

```yaml
id: audit
title: Audit a repository
trigger: "jevlint audit"
steps:
  - { from: cli, to: audit, verb: "runs audit()" }
  - { from: audit, to: decision, verb: "asks each file's questions" }
```

Each step names two components. `returns` adds a return arrow, and `optional: true` draws the step
dashed. `check` reports a step with no import behind it, and `show` draws it dashed.

## `views/<id>.yaml`

A view is a curated diagram: what a reader should see, not every import. jevlint compiles it to
Mermaid with one colour per group and a shape per kind, so the look is consistent whoever writes it.

```yaml
title: Building blocks
description: From the CLI through the pipelines to the model provider.
groups:
  - { id: interface, label: Command line }
  - { id: engines, label: Analysis engines }
nodes:
  - { id: developer, label: Developer, kind: actor }
  - { id: cli, label: CLI commands, kind: component, component: cli, group: interface }
  - { id: decide, label: Decision models, kind: component, path: src/decision, group: engines }
  - { id: provider, label: Model provider, kind: external, packages: ["ai", "@ai-sdk/*"] }
  - { id: cache, label: Answer cache, kind: store, path: src/cache.ts }
edges:
  - { from: developer, to: cli, verb: runs }
  - { from: cli, to: decide, verb: asks questions }
  - { from: decide, to: provider, verb: sends request }
  - { from: decide, to: cache, verb: reads and writes }
```

| Key | Meaning |
| --- | --- |
| `title`, `description` | Shown above the diagram |
| `groups` | At most 8 subsystems, each drawn as a box with its own colour |
| `nodes` | At most 34. `kind` is `actor` (circle), `component` (box), `store` (cylinder), `queue`, `external` (hexagon) or `document`. A node points at code with `path` (a file, directory or glob) or `component`, not both. An `external` node may list `packages` |
| `edges` | At most 48. `verb` is a short phrase, and `style` is `solid` (default) or `dashed` for an optional or indirect relationship |

Every solid arrow is checked against the import graph: some file of the caller must import some file
of the callee, or, for an external node with `packages`, one of those packages. An arrow with no
import behind it is drawn dashed, and `list` warns, saying when the import runs the other way. A node
with neither a path nor a component, such as an actor, is not checked.

A view with `kind: data` is a data model, drawn as an ER diagram:

```yaml
kind: data
title: Reports
entities:
  - id: audit
    name: AuditReport
    path: src/types.ts
    description: What audit returns and --json prints.
    fields:
      - { name: files, type: "FileReport[]" }
  - { id: file, name: FileReport, path: src/types.ts, fields: [{ name: score, type: number }] }
relations:
  - { from: audit, to: file, cardinality: one-to-many, label: ranks }
```

At most 20 entities with 12 fields each. `cardinality` is `one-to-one`, `one-to-many`,
`many-to-one` or `many-to-many`. `list` warns when an entity's file does not declare a data type of
that name.

## `chapters/<name>.md`

The prose of the document, one Markdown file per chapter, ordered by file name. Each starts with
frontmatter:

```markdown
---
title: Design principles
evidence: [AGENTS.md, src/config.ts:17-40, commit:5f1db8a]
---

### Only the decision layer talks to models

…

<!-- jevlint:diagram overview -->
```

| Part | Meaning |
| --- | --- |
| `title` | The chapter's heading. jevlint adds it as `##`, so use `###` and lower inside |
| `evidence` | What the chapter is based on: `path`, `path:line`, `path:start-end` or `commit:<hash>` |
| `<!-- jevlint:diagram NAME -->` | Places a diagram: a view id, `flow:<id>`, `component:<id>`, `map`, `layers`, or `components` for every component's reference section |

`list` warns when a chapter cites nothing, when a cited path, line or commit does not exist, and
when a backticked `path:line` in the text does not. `drift` reports a chapter as `stale-chapter` when a file
it cites changed since `compiled_at`, so that an update rewrites only that chapter. A chapter has at
most 60 KB, and `list` warns above 1,500 words for one chapter or 9,000 for all.

### The document

`show --markdown` builds the ARCHITECTURE.md. With chapters, it is the system's description, each
chapter in order with its diagrams in place, then the views and flows no chapter placed, then a
reference: every component, the externals, the rules and the checklist. Without chapters, it is the
structure in a fixed order: layers, each view, the map, the components, the flows and the reference.
`show --view <id>` draws one view, and `show --html` puts the chapters, the views and the map on one
page with no scripts.

## Rules

Every rule is decided from the AST and the import graph, with no model and no network. A rule in
`index.yaml` has the id you give it; a rule in a component is `<component>.<id>`.

| Kind | Fields | Meaning | Violation |
| --- | --- | --- | --- |
| `layers` | | A component depends only on its own layer or lower ones | `layer-violation` |
| `no-cycles` | | No cycle between components | `component-cycle` |
| `only` | `externals`, `components` (in `index.yaml`) | Only these components may import these externals. In a component, the component itself | `restricted-external` |
| `forbid` | `packages`, `components`, `from` (in `index.yaml`) | No import of these packages or components | `forbidden-dependency` |
| `forbid-call` | `pattern`, `language`, `from`, `except` | No code matching this [ast-grep pattern](extending.md#ast-patterns). With no `language`, languages the pattern does not parse in are skipped | `forbidden-call` |

And always, with no rule to write:

| What | Violation |
| --- | --- |
| An import of a component that `depends_on` does not list | `undeclared-dependency` |
| A flow step with no import behind it | `missing-flow-step` |
| A `key_files` path or `interface` name that does not exist | `stale-reference` |
| A source file in no component and not in `ignore` | `unmapped-file` |

Package names match with `*` for any characters: `@ai-sdk/*`, `node:*`. jevlint names an import
that resolves to no repository file by its package: `@scope/name` or `name`, `node:fs` for Node
built-ins whether written `fs` or `node:fs/promises`, `go:fmt` for Go's standard library, and
`rust:std`.

The SSOT holds globs, package names, ast-grep patterns and prose only. It cannot name a command, a
URL or a path outside the root, so a hostile repository cannot make jevlint run anything.

## Validation

`jevlint architecture list` loads the SSOT with the same checks every command applies, then checks
its views and chapters against the code and warns on stderr about what does not fit. It exits 2
with every error when it does not load: unknown keys, ids that break the rules above, a glob with
`..` or a leading `/`, a `forbid` with nothing to forbid, and any `layer`, `depends_on`, `uses`, rule
or flow step that names something that does not exist.

### Size budget

The point of the SSOT is a low cognitive load, so `list` warns on stderr when it is over budget:

| Budget | Limit |
| --- | --- |
| Components | 25 |
| Sentences in a summary | 3 |
| Key files per component | 5 |
| Tokens in all, at about four characters each, not counting views and chapters | 8000 |

## Facts

Every command starts from facts that static analysis collects from every source file with a
grammar, with no network:

| Fact | How |
| --- | --- |
| Dependencies with evidence | Each import keeps its line, and resolves through relative paths, the root `tsconfig.json`'s `paths` and pnpm, npm and bun workspace packages |
| Externals | An import that resolves to no file becomes a package, classified by a [table](../src/architecture/externals.ts) as a known system (`pg` → PostgreSQL, `ai` → AI SDK), a library or the runtime |
| Component candidates | Directories with subdirectories are split, smaller ones stay whole, and loose files are clustered by import cohesion (greedy modularity). While candidates import each other in a cycle, the one whose split by module layer removes the most files from cycles is split. At most 25 |
| Layers | Candidates' strongly connected components, in topological order. 0 depends on no other candidate |
| Rank and interface | PageRank over the candidate graph, and the names other candidates import |
| Entry points | `package.json` `bin` and `main` (`dist/` read as `src/`), Next.js routes and pages, Express and FastAPI handlers, `main.go`, `src/main.rs`, `__main__.py`, from a [table](../src/architecture/entrypoints.ts) |
| Flows | The longest dependency chain from each entry point's candidate |
| Churn and co-change | Commits per file over `priority.churn_days`, and candidates whose files change together in at least 3 of the last 300 commits with no import between them |
| Tests | Files under `test/`, `tests/`, `*-tests/`, `__tests__/`, `fixtures/`, `e2e/`, a top-level `spec/`, and `*.test.*`, `*.spec.*`, `*_test.go`, `test_*.py`, left out of candidates and listed as globs for `ignore` |
| Data types | Interfaces, object types and classes with fields (TypeScript), classes with annotated fields (Python), structs (Go and Rust), with the other data types their fields name. The 40 most referred to are kept |
| Comments | Comments that are not doc comments or tool directives, which in a codebase that comments why are the reasons behind the code. The compile prompt shows those in central files |

Each file's outline is cached by content hash in your [cache directory](caching.md), so a second run
reads only what changed. `--no-cache` skips it. `show --json` prints the facts.

## Compile

`jevlint architecture compile` prints a prompt that asks a coding agent to write the whole document:
the structure, the views and the chapters. It holds no file contents, only:

- the facts: candidates, dependencies with file and line, externals, entry points, flows, cycles,
  co-changes and tests;
- material for the reasons: the instruction files and design documents that exist (`AGENTS.md`,
  `CLAUDE.md`, `CONTRIBUTING.md`, `docs/architecture.md`), the data types, the comments in central
  files, and the 25 commits most worth reading, chosen from the last 400 by files touched and
  message length;
- a draft of the structure, with `TODO` where only a person or an agent can name and explain.

The prompt sets out how to work, in order: research the material and the central files; write notes
of every claim with its evidence before writing anything; write the structure; draw the views by
rules taken from [GitDiagram](https://github.com/ahmedkhaleel2004/gitdiagram)'s generator (the
caller owns each arrow, no invented pipelines, solid only with an import behind it, short verbs and
labels, start from the actor); write the chapters by a fixed outline (overview, principles, building
blocks, runtime, data, cross-cutting concerns, decisions, risks, change guide, glossary) and writing
rules (every principle with its reason and cost, every decision with its alternatives, every claim
with evidence, nothing generic); review the result as a newcomer; and run `list` and `check
--static` until they are clean. The agent ends with questions for a person.

With `--agent`, jevlint runs `list`'s checks after the agent finishes and, while they report
anything, gives the agent the problems to fix, at most twice.

When an SSOT exists, the prompt asks for an update instead: the drift since `compiled_at` (or
`--since`), including chapters whose evidence changed and views that no longer fit, the files added
and removed, and the instruction to rewrite only those parts and keep ids. When the SSOT does not
load, the prompt holds the errors. `--docs` adds more documents as context.

## Check

1. Each file is assigned to a component by `paths`.
2. Every [rule](#rules) is decided from the AST. Each violation has a file and a line.
3. Unless `--static`, each file with items to judge is sent once, with the global checklist and its
   component's, as choice questions: `satisfies`, `violates` or `not-applicable`, the options of
   `spec check`. Items have full ids: `global.<id>` and `<component>.<id>`.
4. A full run lists checklist items no file satisfies as unimplemented.

`--diff <base>` reads the base from git and reports only the violations that are new, matched by
rule, rule id, path and target, not by line, so code that moves stays matched. Checklists are judged
only in files changed since `base`, untracked ones included. `pr --architecture` and
`commits --architecture` compare each change's base and head the same way, both read from git.

`--new` leaves out violations that `jevlint baseline` recorded. Violations in a component with
`status: target` are listed apart and do not affect the exit code.

## Drift

| Kind | Meaning | Decided by |
| --- | --- | --- |
| `unmapped-code` | A file, or a directory of them, in no component. `since` marks code added after `compiled_at` | AST |
| `undocumented-dependency` | A component dependency its `depends_on` does not list | AST |
| `undocumented-external` | A component imports a declared external its `uses` does not list, or a known system no `externals` entry names | AST |
| `stale-reference` | A `paths` glob, `key_files` entry or `interface` name that matches nothing, a component with no files, or a `depends_on` or `uses` entry the code never imports | AST |
| `stale-summary` | A component, among those whose files changed since `compiled_at`, whose summary the model thinks no longer fits its outline | `architecture-drift.summary-current`, a boolean |
| `stale-chapter` | A chapter that cites a file changed since `compiled_at` | git |
| `stale-view` | A view node whose path matches nothing, a solid arrow with no import behind it, or a data entity whose type is gone | AST |
| `document` | With `--docs`: a document that contradicts a summary or checklist item, or states a structural fact the SSOT leaves out | Two requests per document, as `spec drift` |

A drift item is not a violation: it says the SSOT needs an update. `--copy` and `--prompt` give the
update prompt.

## Plan

`jevlint architecture plan` takes the violations of a static check (of the draft when there is no
SSOT) and the module graph's hubs, groups them by kind and ends, and ranks them by severity × (1 +
ln(1 + churn)) × (1 + fan-in) of the component they weigh on. Severity runs from 5 for a cycle and
4 for a layer violation down to 1 for a stale reference. Each step has a computed move:

| Problem | Move |
| --- | --- |
| Component cycle | Cut the edge in the cycle with the fewest imports |
| Layer violation | Move what is used down, or invert the dependency |
| Restricted external, forbidden dependency or call | Move the import or call into the component the rule allows |
| Undeclared dependency | Declare it if intended, or remove the imports |
| Hub | Split the file by the components that use it |

`--json` prints the plan, and `--prompt`, `--copy` or `--agent` hand it to a coding agent to write
`plan.md`. Nothing changes code.

## Questions

| Verb | Unit | Sends | Questions | Requests |
| --- | --- | --- | --- | --- |
| `check` | Code file | File contents, as `audit` does | One choice per checklist item | One per file with items |
| `drift` | Changed component | Outline and summary | `architecture-drift.summary-current` | One per changed component |
| `drift --docs` | Document | Document, then its statements | Route to a component, then `agrees`, `contradicts` or `absent` per statement, and `uncovered` | Two per document |
| `review`, `component` | Component | Outline and summary, no code | `architecture-component`: `summary-fit`, `dependencies`, `naming` | One per component |
| `review`, `design` | SSOT | The SSOT's YAML, without `compiled_at`, views and chapters | `architecture-design`: `responsibilities`, `layering`, `direction` | One |
| `review`, `chapter` | Chapter | Its title, evidence list and text | `architecture-chapter`: `explains-why`, `specific`, `evidence` | One per chapter |

Every request goes through the decision cache, whose key covers the question text, so editing a
summary or an item asks again and nothing else does. The preset questions can be
[tested with fixtures](presets.md#testing-a-question) in `.jevlint/fixtures/<preset>.<id>/`, without
adding the presets to `presets`. `compile`, `list`, `show` and `plan` never call the decision API.

## Limits

- Dependency injection, routes built from strings and calls over HTTP are not in the import graph.
  Add them to a summary with evidence, and cover them with checklist items.
- Languages without a grammar get no facts.
- [Always-excluded files](configuration.md#files-that-are-always-excluded), such as anything named
  `*credentials*` or `*secret*`, are never read, so they are in no candidate and never reported as
  unmapped. Name them in a component's `paths` by hand if they belong there.
- `check --diff` reads both sides through `git cat-file`, one file at a time, so a large repository
  takes a few seconds per side.
