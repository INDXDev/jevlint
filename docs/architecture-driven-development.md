# Architecture-driven development

Codebases grow faster than their architecture documents. `jevlint architecture` recovers the
structure from the code, has a coding agent turn it into a small architecture document that is also
the single source of truth (SSOT), and keeps code and document in agreement. This page is the guide.
The format and every rule are in the [SSOT reference](architecture-reference.md).

## The idea

```
   code ── facts (AST) ── compile (agent) ──▶ SSOT ── show ──▶ diagrams, ARCHITECTURE.md
    ▲                                          │
    └──────────── check ───────────────────────┤
    └──────────── drift: what grew since ──────┘
```

Most design decisions live in the code: which module calls which, which layer owns a provider SDK.
Static analysis recovers that exactly and for free. People and agents add what it cannot: names and
meaning. So the work is split by what each part does well:

| Work | Who | Why |
| --- | --- | --- |
| Dependencies, layers, cycles, externals, entry points, conformance | jevlint, from the AST | There is an exact answer, and asking a model adds cost and noise |
| Fixed questions about meaning, such as "does this summary still fit?" | The decision model | A calibrated, cacheable answer |
| Naming, summarising, merging and splitting components, discussing the design | A coding agent | Writing and judgement. jevlint never writes the SSOT |

`jevlint spec` is the counterpart for what a team writes from its documents. `architecture` is what
jevlint and an agent recover from the code.

## Get started

### 1. Look at the current shape

```sh
jevlint architecture show                          # in the terminal
jevlint architecture show --html architecture.html # one offline page
```

With no SSOT, this draws the component candidates the facts propose. It needs no key and no network.

### 2. Compile the SSOT with a coding agent

```sh
jevlint architecture compile --agent claude   # or: jevlint architecture compile | claude -p
jevlint architecture list
```

The prompt holds the facts, a draft and the material for the reasons behind the design: instruction
files, data types, comments in central files and the commits most worth reading. The agent researches
the code, notes every claim with its evidence, then writes `.jevlint/architecture/`: the structure
jevlint checks, curated diagrams (a system context, the building blocks and the data model, drawn by
GitDiagram's rules) and chapters on principles, runtime, data, decisions, risks and how to change
things. jevlint then checks every arrow against the imports and every citation against the files,
and hands what fails back to the agent. Review the diff as you would code, then commit it.

### 3. Read it, and let agents read it

```sh
jevlint architecture show --markdown > docs/ARCHITECTURE.md
jevlint architecture show --view component:decision
```

Point `AGENTS.md` or `CLAUDE.md` at the Markdown, so a coding agent starts from it instead of
exploring the repository from scratch.

### 4. Review the design

```sh
jevlint architecture review --perspective design,component
jevlint architecture review --prompt | claude -p
```

Scores rank the parts; the agent explains them.

### 5. Check the code against it

```sh
jevlint architecture check --static   # structural rules only, no model
jevlint baseline --ast-only           # record today's violations as known
```

### 6. Gate in CI and on pull requests

```sh
jevlint architecture drift --static && jevlint architecture check --static --new
jevlint pr --architecture --ast-only
```

`drift` fails when the code has outgrown the SSOT; `check --new` fails on a new violation. A pull
request that adds one import against the layers produces exactly one violation.

### 7. Update the SSOT when the code grows

```sh
jevlint architecture drift --prompt | claude -p
```

The agent updates only what drifted and keeps ids, so history stays readable.

### 8. Plan a refactoring

```sh
jevlint architecture plan
jevlint architecture plan --prompt | claude -p    # writes .jevlint/architecture/plan.md
```

## Commands

| Command | What it does | Model |
| --- | --- | --- |
| `compile` | Prompt an agent to write or update the SSOT from the facts | No |
| `list` | Validate and print the SSOT | No |
| `show` | Draw it, or the draft, with real dependencies laid over declared ones | No |
| `review` | Score the structure, each component and the design | Yes, unless `--ast-only` |
| `check` | Decide every structural rule from the AST, and judge checklists | Checklist items only |
| `drift` | Find what the SSOT no longer describes | Summaries and `--docs` only |
| `plan` | Rank problems and compute a move for each | No |

See the [CLI reference](cli.md#jevlint-architecture) for every flag.

## What leaves your machine

`compile`, `list`, `show`, `plan`, `check --static`, `drift --static` and `pr --architecture` send
nothing. `review` sends outlines and the SSOT, never code. `check` sends the contents of files that
have checklist items to judge, as `audit` does. `drift` sends the outlines and summaries of changed
components, and documents with `--docs`. See [Security](security.md#what-leaves-your-machine).

## Why an agent writes and jevlint checks

Principles, decisions and trade-offs are judgement and prose, which a coding agent does well and a
static analyser cannot. But prose drifts into claims nobody can check. So jevlint gives the agent
the evidence (imports with lines, data types, the comments and commits that record reasons), asks
for evidence with every claim, and checks what it can: arrows against imports, citations against
files and lines, and, through `drift`, which chapters cite code that has since changed. `review
--perspective chapter` scores each chapter for reasons, specificity and evidence.

## Tips for a good SSOT

- Keep it small: 8 to 25 components, one to three sentences each. `list` warns when it grows past
  the [budget](architecture-reference.md#size-budget).
- Put what has an exact answer in `rules`, so it costs nothing to check, and only what the structure
  cannot show in `checklist`.
- Use `status: target` for a component you are moving towards. Its violations show as distance from
  the target without failing the check.
- Do not accept the candidates as they are. They follow directories and imports, and the agent is
  told to merge and split where the code says so; check that it did.
