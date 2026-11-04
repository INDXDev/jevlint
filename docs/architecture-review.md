# Architecture review

`jevlint audit` judges files one at a time. `jevlint architecture` looks at how they fit together,
from three perspectives, and ranks everything from worst to best in one list.

| Perspective | Reviews | Asks about |
| --- | --- | --- |
| `codebase` | The repository as one unit | Visible shape, one-way layers, balance of size |
| `directory` | Each directory | Cohesion, boundaries, naming |
| `class` | Each class with methods | Single responsibility, relationships, naming |

```sh
jevlint architecture                            # summary in the terminal
jevlint architecture --html architecture.html   # visual report
jevlint architecture src --ast-only             # one folder, nothing sent
jevlint architecture --perspective class --top 50
```

## How it works

1. **Split.** The AST gives each file's imports, top-level names and classes, in every
   [supported language](#language-support).
2. **Connect.** Imports become a module graph, which rolls up into a directory graph. Classes link
   by inheritance and by use.
3. **Measure.** The graphs are checked against the limits below.
4. **Ask.** Each unit's outline goes to the decision model, with the questions for its perspective.
   An outline holds paths, line counts, names and dependencies. It never holds file contents.

One unit is one request, so a review costs 1 + directories + classes with methods. Use
`--perspective` to limit that in a repository with many classes. Results are cached like any other
decision.

## What it finds

| Rule | Meaning | Limit |
| --- | --- | --- |
| `dependency-cycle` | Files that import each other, directly or through others | None allowed |
| `directory-cycle` | Directories that depend on each other | None allowed |
| `fan-out` | A file that imports too many others | `max_fan_out` |
| `hub` | A file with many imports and many users, so changes ripple both ways | `max_hub_links` |
| `directory-files` | A directory with too many files | `max_directory_files` |
| `class-methods` | A class with too many methods | `max_class_methods` |
| `class-lines` | A class that is too long | `max_class_lines` |
| `inheritance-depth` | A chain of parent classes that is too deep | `max_inheritance_depth` |

Set the limits in [`[architecture]`](configuration.md#architecture-limits).

A folder and its own subfolder never count as a directory cycle, because `src/` and `src/ast/` are
one unit that commonly refers to itself.

## Reading the report

The visual report opens with the ranking, then shows directories, modules and classes as diagrams.

- **Columns are layers.** Entry points are on the left, and foundations are on the right. Every box
  depends only on boxes further right, so anything else stands out.
- **Red lines are cycles.** Boxes in a cycle carry a `✕`, and boxes with another finding carry a `!`.
- **Hover a box** to trace its links and see its numbers.
- **Warnings** appear in the terminal and HTML reports only when there are some. They say why a unit
  has no model score, or that its outline was truncated.

The file has no scripts and makes no network requests, so you can attach it to a pull request or
open it offline.

## Scores

A unit's structure score works like a file's AST score: the worst finding sets it, as limit divided
by value. A cycle of two scores 0.5. A directory counts its own findings, a class counts findings
about that class, and the codebase counts every finding.

That score blends with the model's answers using `ast_weight` and `model_weight`. A class without
methods gives a model nothing to judge, so it is left out of the ranking unless it has a finding.

Each perspective's score, and the overall score, are means weighted by lines.

The model part moves with small changes, as it does in an audit. See
[Small changes mean nothing](scoring.md#small-changes-mean-nothing). The AST findings do not.

`jevlint-score` pins do not apply here, because they describe files rather than structure.

## Changing the questions

Each perspective has a built-in preset: `architecture-codebase`, `architecture-directory` and
`architecture-class`. To replace one, install a preset with the same name. `[weights]` works as
usual:

```toml
[weights]
"architecture-class.naming" = 0
```

Do not add these to `presets`, which would ask their questions about single files.

## Language support

| Language | Imports | Classes |
| --- | --- | --- |
| JavaScript, TypeScript | Relative imports, `require`, dynamic `import()` | `class` |
| Python | Absolute from the root or `src/`, and relative | `class` |
| Go | Packages inside the module named in `go.mod` | Types, with their methods |
| Rust | `crate::`, `self::`, `super::`, and `mod name;` | `impl` blocks and traits |

Known limits:

- TypeScript `paths` aliases and workspace packages are not followed, so those links are missing.
- A Go package maps to its first non-test `.go` file. Read Go repositories at directory level.
- A class name declared in two files links to nothing, because a name alone cannot say which is meant.
- Go methods merge with their type only within one file.
- Files in `exclude` are not in the graph, including anything that links through them.
- A file jevlint cannot read is left out of the graph with no warning.
- Top-level destructuring patterns are not listed as names, because they can hold literals.
- TypeScript `export import b = require('./b')` is not read as an import.
