# Scoring

All scoring happens on your machine from cached or fresh inputs, so changing weights costs nothing.
Internally every score runs from 0 (worst) to 1 (best). Higher is always cleaner.

## Scale

`scoring.scale` sets the displayed maximum. The default is 100. Use `1` for scores from 0 to 1, and
raise `precision` to keep decimals:

```toml
[scoring]
scale = 1
precision = 2
```

## AST score

Each metric gets a sub-score, using the worst value in the file:

```
sub_score = min(1, limit / worst_value)
```

A function at twice the limit scores 0.5. The AST score is the worst sub-score, reduced by 5% for
each pattern match and each [semantic rule](presets.md#semantic-rules) hit, because a file is only as
clean as its worst part:

```
ast_score = min(sub_scores) × 0.95 ^ (pattern_matches + rule_hits)
```

Rule hits need a model, so a file can score higher with `--ast-only`. Thresholds apply after the
cache, so tuning one costs nothing.

| Metric | Config key | Measures |
| --- | --- | --- |
| Cognitive complexity | `max_cognitive_complexity` | How hard a function's control flow is to follow |
| Nesting | `max_nesting` | Deepest block nesting in a function |
| Function length | `max_function_lines` | Lines in a function |
| Parameters | `max_params` | Parameters on a function, not counting a receiver such as `self` |
| File length | `max_file_lines` | Lines in a file |

Cognitive complexity follows the approach of
[SonarSource's metric](https://rules.sonarsource.com/typescript/RSPEC-3776): each branch or loop adds
1 plus its nesting depth, and each run of logical operators adds 1. Our implementation is a
cross-language approximation, so values can differ from SonarQube's.

### Languages without a grammar

TypeScript, JavaScript, Python, Go and Rust get exact metrics from an ast-grep grammar. Any other
source file, such as Java, Ruby, PHP, C or Lua, gets the same metrics approximated from keywords
and indentation. It needs consistent indentation, and the terminal marks its score `AST ~`.

- It finds functions by keywords such as `def`, `func` and `function`, by assignments of them, and by
  C-style declarations followed by a block.
- It misses anonymous closures and C-style signatures split over lines. Code it cannot place in a
  function is not measured, so it under-reports rather than invents findings.
- `case` labels, `do` loops and ternaries add no complexity.
- `[[patterns]]` and `[[rules]]` do not apply, because they need a grammar.
- A file with no function, within `max_file_lines`, gets no AST score, because that says nothing
  good about it.

## Model score

Each answer converts to a compliance value:

| Question | Compliance |
| --- | --- |
| `score` | `answer / (levels - 1)` |
| `boolean`, `good = true` | `probability` |
| `boolean`, `good = false` | `1 - probability` |

The model score is the weighted mean of all active questions.

## File score

```
file_score = (ast_weight × ast_score + model_weight × model_score) / (ast_weight + model_weight)
```

If only one engine ran, its score is the file score. That happens with `--ast-only`, for a file in
which no function was found, or after a provider error. A file with neither engine is listed as skipped.

## Repository score

The mean of file scores, weighted by line count.

## Priority

The table is sorted by priority, not by score, because a messy file nobody touches matters less than
a messy file changed every week:

```
priority = (1 - file_score) × (1 + churn × churn_norm + size × size_norm)
```

- `churn_norm` is `log(1 + commits) / log(1 + max_commits)`, where commits are counted over
  `churn_days`.
- `size_norm` is the same calculation using line counts.

Outside a git repository, churn is 0. Set `priority.churn` and `priority.size` to `0` to sort purely
by score.

## Small changes mean nothing

Model scores are repeatable: the same input always gives the same number. They are not smooth. In
one test with `gpt-6-luna`, adding a single blank line to a file lowered its score by 3 points out of
100, and renaming a helper lowered it by 4, with no change in quality.

So treat a move of a few points as noise. Do not refactor to win them back, and do not read them as
progress. When a score is good enough, [pin it](#pinning-scores).

## Pinning scores

A `jevlint-score` comment fixes a score your team has accepted, in the same spirit as
`eslint-disable`. It ends the argument with the number, and stops agents chasing it.

```ts
// jevlint-score 75 -- Table layout is inherently fiddly, and has been reviewed
// jevlint-score readable-code.naming 90 -- Short names are standard terms in this domain
```

The first form pins the whole file. The second pins one question, by its full id. Values use your
configured `scale`. The comment must be on a line of its own, using `//`, `#`, `--` or `/* */`, and
the reason after ` -- ` is required.

| | Whole-file pin | Question pin |
| --- | --- | --- |
| File score | The pinned value | Recalculated with the pinned answer |
| Model call | None, and the source is not sent. [Semantic rules](presets.md#semantic-rules) do not run | Unchanged |
| Priority | 0, so the file ranks last | Normal |
| `prompt` and `fix` | File is left out | Question is left out |
| AST analysis | Still runs, and shows in `explain` | Unchanged |

jevlint removes these lines before sending a file or a rule match to a model. Adding one therefore
cannot move the file's score, and the cached result stays valid.

A malformed pin, or one for an unknown question, is ignored and appears as a warning in
`jevlint explain`.

Pins count towards the repository score, and a pin can hide later decline. Review them now and then:

```sh
jevlint audit --ignore-pins
```

## Using scores well

- Compare a repository with itself over time, on one pinned model.
- Set `fail_under` from a score you measured, not a number you hope for.
- Model answers can vary between models and versions, and [small moves are noise](#small-changes-mean-nothing).
- A high score does not mean code is correct. jevlint judges cleanliness, not behaviour.
