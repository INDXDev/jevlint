# Concepts

## The problem

Traditional linters find local rule violations. They cannot say whether a name is meaningful or a
module has one clear purpose, and they rarely say what to fix first. On a large codebase that gives
you thousands of equal-looking warnings.

jevlint answers a different question: **which file should we refactor next, and why?**

## Two engines

Each file goes through two independent engines.

| | AST analysis | Decision model |
| --- | --- | --- |
| Answers | What is measurable | What needs judgement |
| Examples | Complexity, nesting, function length | Are names meaningful? Is this module deep? |
| Runs | On your machine | At your provider |
| Cost | Free | Input tokens |
| Languages | JavaScript, TypeScript, Python, Go, Rust, and [approximately](scoring.md#languages-without-a-grammar) any other source file | Any source file |
| Precision | Exact line numbers | Whole-file judgement |

A file gets one consistent score from whichever engines could process it. See
[Scoring](scoring.md).

## Decision models

A decision model reads some state and answers typed questions. It does not write prose. You get
numbers back:

- **Boolean**: the probability that a statement is true.
- **Score**: a position on a rubric of ordered levels.

Examples include TypeSafe AI's Jev, Cloudflare's Clef, Microsoft-Decision-1 and OpenAI's
`gpt-6-luna`.

This suits a linter well:

- **Comparable.** Every file answers the same questions on the same rubric, so results rank.
- **Cheap.** You pay for input tokens only, and there is no generated text to wait for.
- **Cacheable.** A number per question is small and easy to reuse.

The trade-off is that a decision model cannot explain itself or point at a line. jevlint fills that
gap with the title and fix guidance written into each [preset](presets.md) question, and with the
AST's line numbers. Coding agents then locate the specific code. For a judgement that needs a line,
a [semantic rule](presets.md#semantic-rules) has ast-grep pick the code, and asks about each match.

Treat scores as calibrated opinions, not facts. Different models give different numbers, so compare
results from the same model, and set any CI threshold from your own data.

## One file, one request

jevlint sends each file on its own, with every active question in a single request. This keeps the
treatment uniform and lets a result be cached by file content. It also means a model cannot judge
relationships between files directly. Presets such as `clean-architecture` assess what is visible
from one file, such as its imports. Semantic rules add one small request per match.

## The pipeline

1. **Load config**: merge defaults, user config, repository config and flags.
2. **Discover**: list files, honouring `.gitignore`, `include` and `exclude`.
3. **Analyse**: run AST metrics locally.
4. **Decide**: check the cache, otherwise ask the provider, for each file and each rule match.
5. **Score**: convert everything into one number per file.
6. **Rank**: combine the score with git churn and size.
7. **Report**: print a table, or JSON with `--json`.

`prompt`, `fix` and `explain` run the same pipeline, so they use the cache and always reflect the
current code. `pr` and `commits` run it on both sides of a change, in temporary snapshots, and keep
only what got worse.

## Presets

A preset is a TOML file of questions, plus optional AST patterns and semantic rules, that encodes a
set of principles.
You can combine presets, weight individual questions, or write your own.

## Pins

Model scores are opinions, and they shift on trivial edits. When a team accepts a score, a
`jevlint-score` comment fixes it, so nobody spends time chasing a number. See
[Pinning scores](scoring.md#pinning-scores).

## Hand-off

jevlint finds and ranks. It does not rewrite code. `jevlint prompt` turns findings into instructions
for a coding agent, and `jevlint fix` runs that agent on request.
