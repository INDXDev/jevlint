# JSON output

`--format json` is the same as `--json`. This page covers `audit --json`, then [`audit --new`](#new-issues),
[`audit --dry-run --json`](#dry-run), [`pr` and `commits`](#change-reviews),
[`test --json`](#fixture-results) and [`architecture --json`](#architecture-report).
`explain --json` prints one entry of `files`.

`jevlint audit --json` prints one object to stdout. Files are sorted by priority, highest first, and
every file is included regardless of `--top`.

```json
{
  "root": "/path/to/repo",
  "provider": "typesafe",
  "model": "jev-latest",
  "presets": ["readable-code"],
  "scale": 100,
  "score": 58,
  "files": [
    {
      "path": "src/orders/process.ts",
      "language": "typescript",
      "lines": 212,
      "score": 21,
      "priority": 1.12,
      "commits": 31,
      "ast": {
        "score": 0.39,
        "findings": [
          {
            "rule": "cognitive-complexity",
            "message": "cognitive complexity 38 (max 15)",
            "line": 12,
            "symbol": "handleOrder",
            "value": 38,
            "limit": 15
          }
        ]
      },
      "model": {
        "score": 0.09,
        "answers": [
          {
            "id": "readable-code.naming",
            "title": "Names pack information",
            "compliance": 0.12,
            "weight": 2,
            "fix": "Rename vague identifiers so each states what it holds."
          }
        ],
        "presets": { "readable-code": 0.09 },
        "cached": true,
        "truncated": false,
        "inputTokens": 1840
      },
      "warnings": []
    }
  ],
  "skipped": ["scripts/deploy.sh"],
  "usage": { "inputTokens": 1840, "estimatedCostUsd": 0.00007728, "cacheHits": 13, "modelCalls": 1 }
}
```

## Notes

- `score` at the top level and on each file uses the configured `scale`.
- `ast.score`, `model.score`, `compliance` and `presets` values always run from 0 to 1.
- `ast` is `null` when a file has no grammar and no function was found. `model` is `null` when no
  model ran.
- `ast.approximate` is `true` when the file had no grammar, so `language` is `null` and the metrics
  are [estimates](scoring.md#languages-without-a-grammar). The field is absent otherwise.
- A finding from a [semantic rule](presets.md#semantic-rules) has `probability` (0 to 1) and `fix`,
  and no `value` or `limit`.
- `ruleUsage` appears on a file when a semantic rule got an answer, with `inputTokens`, `cacheHits`
  and `modelCalls`. `usage` includes it.
- `pin` appears on a file or an answer fixed by a
  [`jevlint-score` comment](scoring.md#pinning-scores), with `value` (0 to 1), `reason` and `line`.
- `inputTokens` on a cached file is what the original request used, and `usage.inputTokens` counts
  only this run.
- `usage.estimatedCostUsd` is a [rough cost](providers.md#cost-estimates) of this run, or `null` when
  no model ran or its price is unknown.

The shape follows [semantic versioning](https://semver.org). Before 1.0, minor releases may change
it, as noted in the changelog. The types live in `src/types.ts`.

The same data is available from the [library API](extending.md#library-api).

## New issues

`jevlint audit --new --json` prints the same object, narrowed to what is new or worse than the
[baseline](cli.md#jevlint-baseline-paths):

- `files` holds only files with something new, and a file's `ast.findings` and `model.answers` hold
  only the new items. With nothing new, `files` is empty.
- Everything else is as in a full audit. `score` on the report and on each file, `ast.score`,
  `model.score`, `skipped` and `usage` still describe the whole run.

## Dry run

`jevlint audit --dry-run --json` prints one object to stdout:

| Key | Holds |
| --- | --- |
| `files` | Paths that would send anything: the file, or a [semantic rule](presets.md#semantic-rules) match |
| `skipped` | How many files found would send nothing: pinned, blank or already cached |
| `chars` | Characters of those files and rule matches that would be sent |
| `estimatedTokens` | Rough input tokens, including the questions and rule matches. 0 with `--ast-only` |
| `estimatedCostUsd` | A [rough cost](providers.md#cost-estimates), or `null` with `--ast-only` or an unknown price |

## Change reviews

`jevlint pr --json` and `jevlint commits --json` print an array with one object per change, newest
first. `pr` prints one.

| Key | Holds |
| --- | --- |
| `title`, `base`, `head` | The change. `base` is `null` for a root commit |
| `provider`, `model`, `scale`, `usage` | The same as `audit --json`. `usage` covers both sides |
| `files` | `path`, `before`, `after`, `findings`, `answers`, `warnings`. `before` is `null` for a new file |
| `skipped` | Changed files that could not be scored |
| `intent` | With `--intent` and a model: every [answer](#notes) about the change, in the shape of `model.answers`, weak or not. Empty if it could not be judged |
| `warnings` | With `intent`: why it is empty, or that the diff was truncated |
| `architecture` | With `--architecture`: the [violations](#architecture-ssot-reports) the change added |
| `acceptance` | With `pr --acceptance` and a model: the pull request judged against its acceptance criteria, below |

`findings` holds only what the change introduced or made worse, and `answers` only the weak answers
it lowered. `usage` includes the `--intent` and `--acceptance` requests.

`acceptance` holds:

| Key | Holds |
| --- | --- |
| `score` | The points of the verdicts over the criteria that count, on the configured scale. `null` when none count |
| `criteria` | Each criterion: `source` (`PR` or `#<n>`), `line` in that text, `heading` (the headings above it, joined by ` > `), `text`, `probability` that it is a criterion, `verdict` (`met`, `partly`, `not-met` or `cannot-tell`) and `confidence` in it. `verdict` and `confidence` are `null` when it could not be judged |
| `rejected` | The chunks that were not criteria, with `source`, `line`, `heading`, `text` and `probability` |
| `warnings` | What went wrong on the way: issues not read, no criteria found, no diff, provider errors, truncation |

```json
"acceptance": {
  "score": 80,
  "criteria": [
    { "source": "#19", "line": 214, "heading": "Acceptance criteria", "text": "...", "probability": 0.93, "verdict": "met", "confidence": 0.88 }
  ],
  "rejected": [
    { "source": "PR", "line": 3, "heading": "Background", "text": "...", "probability": 0.08 }
  ],
  "warnings": []
}
```

## Fixture results

`jevlint test --json` prints one object. Warnings also go to stderr.

| Key | Holds |
| --- | --- |
| `provider`, `model`, `usage` | The same as `audit --json` |
| `results` | One entry per fixture, sorted by question, then file |
| `warnings` | Unknown fixture directories, truncated fixtures and, with `--drift`, a differing model or a fixture with no record |

Each result has `question`, `file`, `expected` (`good` or `bad`), `compliance` from 0 to 1 and
`passed`. With `--drift` it also has `recorded`, which is `null` with no record, and `moved`.

## Quickfix

`jevlint quickfix --json` prints one object, after every agent has run. With nothing to fix, `files`
is empty.

| Key | Holds |
| --- | --- |
| `files` | One entry per file an agent worked on, in the order they ran |

Each entry has `path`, `score` before the fix and `after` it, on the configured scale, `commit`,
the short hash of the commit that holds the run's files or `null` when it was not committed, and
`diffs`, one per file the agent changed. `after` is `null` when the file was removed, could not be scored, or
the agent failed, which skips the re-score. `fixers` lists each
[`quickfix.after`](configuration.md#quickfix-after) command's last run on the file, as `command`
(the argument list) and `code` (its exit code), in order, leaving out commands that matched no file
or were not approved. `retried` is `true` when a failing `retry` command gave the agent a second
run. `fixerOnly` lists the paths in `diffs` that only those commands changed, not the agent.

| Key | Holds |
| --- | --- |
| `path` | Relative to the root, with forward slashes |
| `status` | `added`, `modified` or `deleted` |
| `additions`, `deletions` | Lines added and removed |
| `patch` | A git-style unified diff with the original text, which `git apply` accepts. A binary file has a `Binary files … differ` line instead of hunks |
| `scoreBefore` | The file's score before the run, or `null` for a new file or one no audit had scored |
| `scoreAfter` | The file's score from the re-audit, or `null` for a deleted or unscored file |

`scoreBefore` and `scoreAfter` are left out when the agent failed.

## Architecture report

`jevlint architecture --json` prints one object to stdout:

| Key | Holds |
| --- | --- |
| `root`, `provider`, `model`, `scale`, `usage` | The same as `audit --json` |
| `score` | Line-weighted mean of the units, on the configured scale |
| `perspectives` | The same mean for each perspective that ran |
| `units` | `perspective`, `name`, `path`, `line`, `lines`, `score`, `ast`, `model`, `warnings`, lowest score first |
| `warnings` | Problems with the run as a whole, such as a file that could not be read |
| `directories` | `path`, `files`, `lines`, `layer` |
| `modules` | `path`, `directory`, `language`, `lines`, `layer`, `fanIn`, `fanOut`, `symbols` |
| `classes` | `id`, `name`, `path`, `line`, `lines`, `methods` (names), `layer` |
| `edges` | `directories`, `modules` and `classes`: lists of `from`, `to`, `weight`, `cyclic`, and `kind` for classes |
| `findings` | Each has the fields of an AST finding, plus `path` and `directories` |

With an SSOT, `units` also holds `component` units, named by component id with `path` at its YAML
file, one `design` unit, and a `chapter` unit per chapter, and `perspectives` has their means. Without one, nothing changes.

## Architecture SSOT reports

A violation, in `check`, `pr --architecture` and the baseline, has these keys:

| Key | Holds |
| --- | --- |
| `rule` | `layer-violation`, `undeclared-dependency`, `restricted-external`, `forbidden-dependency`, `forbidden-call`, `component-cycle`, `missing-flow-step`, `stale-reference` or `unmapped-file` |
| `ruleId` | The SSOT rule's id: `layers-point-down`, `<component>.<rule>`, `<component>.depends_on`, `flows.<id>`, `<component>.references` or `unmapped` |
| `component` | The component of the offending file, or `null` for an unmapped one |
| `path`, `line` | Where to look. For a reference or flow, the SSOT file and line 1 |
| `target` | The file, package, component, symbol or matched code it points at, when there is one |
| `message` | One sentence |
| `status` | `target` when the component has `status: target`, else `current` |

`jevlint architecture check --json` prints one object:

| Key | Holds |
| --- | --- |
| `root`, `provider`, `model`, `usage`, `warnings` | As above. `provider` and `model` are `null` when no model was asked |
| `dir` | The SSOT directory, relative to the root |
| `complete` | `false` when paths or `--diff` narrowed the run, which leaves `unimplemented` empty |
| `base` | The full hash `--diff` compared with, when given |
| `violations` | Violations that count, in path and line order |
| `targetGaps` | Violations in `status: target` components, which do not affect the exit code |
| `baselined` | How many violations `--new` left out |
| `files` | `path`, `component`, `items`, `warnings`, most checklist violations first. Items are as in `spec check` |
| `checklistViolations` | How many item verdicts are `violates` |
| `unimplemented` | `id` and `text` of each checklist item no file satisfies |

`jevlint architecture drift --json` prints `root`, `dir`, `provider`, `model`, `usage`, `warnings`,
`compiledAt`, `head`, `added` and `removed` (files since `compiledAt`), `docs` (as in `spec drift`),
and `items`, each with `kind` (`unmapped-code`, `undocumented-dependency`, `undocumented-external`,
`stale-reference`, `stale-summary`, `stale-chapter`, `stale-view` or `document`), `component`, `path`, optional `line` and
`target`, `message`, and `since`, true for code added after `compiledAt`.

`jevlint architecture show --json` prints `root`, `draft` (true when there is no SSOT), `ssot` (the
SSOT, or the draft), `edges` (`from`, `to`, `weight` and `status`: `declared`, `violation`, `unused`
or `actual` where `depends_on` is absent) and `facts`. `facts` holds `commit`, `files`, `lines`,
`components` (`id`, `paths`, `files`, `lines`, `layer`, `rank`, `fanIn`, `fanOut`, `central`,
`interface`, `externals`, `churn`), `layers`, `dependencies` (`from`, `to`, `weight`, `evidence` of
`path`, `line`, `target`), `externals` (`id`, `title`, `kind`, `packages`, `users`, `evidence`),
`entrypoints`, `flows`, `cycles`, `coChanges`, `tests`, `dataTypes` (`name`, `path`, `line`, `fields`,
`component`, `refs`, `usedBy`) and `modules`, each with `types` and `comments`.

`jevlint architecture list --json` prints the loaded SSOT: `dir`, `index`, `components`, `flows`,
`views` and `chapters` (`id`, `title`, `evidence`, `body`), with the keys of the YAML files and their
defaults filled in. When `decisions/` holds records, it also prints `decisions`, in file order, each
with the keys of its frontmatter, `file` (the file name without `.md`) and `body`.

`jevlint architecture plan --json` prints `root`, `dir`, `warnings` and `steps`, each with `rank`,
`priority` (from 0 to 1), `problem`, `move`, `component` and `evidence`.

## Spec reports

`jevlint spec check --json` prints one object:

| Key | Holds |
| --- | --- |
| `root`, `provider`, `model`, `scale`, `usage` | The same as `audit --json` |
| `specDir` | The spec directory, relative to the root |
| `complete` | `false` when paths narrowed the run, which leaves `unimplemented` empty |
| `files` | `path`, `feature`, `featureConfidence`, `score`, `items`, `warnings`, most violations first |
| `violations` | How many item verdicts are `violates` |
| `unimplemented` | `id` and `text` of each item no file satisfies |
| `warnings` | Problems with the run as a whole |

`feature` is a feature id, `global` for shared code, or `null` when the file got no answer. `score` is
on the configured scale, or `null` when no item applied. Each item has `id`, `text`, `verdict`
(`satisfies`, `violates` or `not-applicable`) and `confidence` from 0 to 1.

`jevlint spec drift --json` prints one object:

| Key | Holds |
| --- | --- |
| `root`, `provider`, `model`, `specDir`, `complete`, `usage`, `warnings` | As above |
| `docs` | `path`, `feature`, `featureConfidence`, `items`, `uncovered`, `warnings` |
| `contradictions` | How many item verdicts are `contradicts` |
| `uncovered` | Documents whose `uncovered` probability is 0.5 or more |
| `unbacked` | `id` and `text` of each item absent from every document routed to its checklist |
| `undocumented` | Feature ids no document is routed to |

Item verdicts are `agrees`, `contradicts` or `absent`. `unbacked` and `undocumented` are empty when
`complete` is `false`. See the [spec reference](spec-reference.md#json-output) for examples.

`jevlint spec list --json` prints the loaded spec: `dir`, `index` and `features`, with the keys of the
YAML files.
