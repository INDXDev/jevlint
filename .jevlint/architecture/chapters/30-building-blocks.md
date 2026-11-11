---
title: Building blocks
evidence: [docs/architecture.md:27-155, src/commands/shared.ts:1-20, src/audit.ts:1-34, src/review.ts:1-27, src/spec/run.ts:1-8, src/architecture/collect.ts:1-23, src/architecture/conformance.ts:1-19, src/architecture/facts.ts:1-33, src/decision/decide.ts:1-18, src/config.ts:1-19, src/git.ts:1-27, src/fixers.ts:1-4, src/trust.ts:1-18]
---

jevlint has 24 components in five layers. The diagram shows how a run moves from the actor through
a command into one of four pipelines, which share the engines below them. An arrow belongs to the
code that makes the call.

<!-- jevlint:diagram overview -->

### Entry and output (interface)

`cli` routes argv and maps errors to exit codes. `commands` holds one file per command, and
`library-api` re-exports the pipelines for npm users. Commands hand all real work to a pipeline,
then pass its result to a formatter. `reports` formats audits and reviews as terminal tables,
SARIF and GitHub annotations, and renders fix prompts. `architecture-rendering` and
`spec-rendering` do the same for the SSOT and the spec. `reports` also draws diffs
(`src/diff-view.ts`), and renders the fix, quick fix and retry prompts that `fix` and `quickfix`
hand to `agent-handoff`.

### Pipelines

Each pipeline takes a `Config` and returns a report, without printing.

- `audit` (`src/audit.ts`, `src/rules.ts`) is the core loop: discover, measure, ask, judge rule
  matches, score.
- `change-review` judges a change instead of a tree. It audits both sides of a commit range in
  private snapshots through `audit()`, keeps what got worse, and with `--intent` asks one more
  question about the message. It also owns the baseline and the hooks.
- `spec-checks` judges files and documents against `.jevlint/spec/`. Its `run.ts` is the shared
  "one model, many paths, choice verdicts" loop that `architecture-verbs` reuses.
- `architecture-verbs` runs `review`, `compile`, `show`, `check`, `drift` and `plan`. Every verb
  starts from `collect()`, which reads the tree or a commit into outlines and facts.
- `preset-fixtures` runs `jevlint test`, proving that preset questions separate good from bad files.
- `agent-handoff` starts `claude` or `codex` with a prompt the command rendered, runs the project's
  fixers and one retry, re-audits what the agent changed, and turns it into patches. It takes its
  prompts as arguments, so it never imports `prompt.ts` from the layer above.

Pipelines may import each other within the layer. `change-review` calls `audit`, `agent-handoff`
re-runs it, and `architecture-verbs` reads the baseline from `change-review`.

### Engines

Engines compute. Apart from the decision calls and `workspace.ts`, they are pure.

- `ast-metrics` measures code with ast-grep, or with the lexical fallback when a language has no
  grammar.
- `scoring` turns findings and raw answers into scores and priorities, and parses pins.
- `decision` is the single door to a model provider, through the cache.
- `code-facts` turns source files into resolved imports, graphs, component candidates, layers and
  flows.
- `ssot-conformance` compares those facts with the SSOT. It assigns files to components, decides
  rules, finds drift, checks view arrows and chapter evidence, and drafts an SSOT. It also holds
  the architecture questions as data.

### Repository and state (infrastructure)

- `configuration` merges defaults, the user config, `jevlint.toml` and flags, and reads API keys.
- `presets` loads question sets from three sources.
- `repository-access` decides which files may be read, and runs every git and `gh` call through one
  hardened helper.
- `decision-cache` stores answers and outlines by content hash, optionally behind a bucket.
- `fixer-commands` runs `quickfix.after` commands and keeps the user's approvals.
- `ssot-loading` validates the spec and SSOT YAML that the repository owns.

`contracts` (`src/types.ts`) sits under everything. It imports nothing, and every report shape in
it is public JSON.

### Layers

The layer of each component, and the dependencies the code actually has:

<!-- jevlint:diagram layers -->
