# Presets

A preset is a set of principles expressed as questions. Scores in a report show how well each file
complies with the presets you selected.

```toml
presets = ["readable-code", "solid"]
```

## Choosing presets

Run `jevlint preset` on its own to pick a preset from a list, then show its questions, edit it, make it
a default or start a new preset from it. `jevlint audit --help` and `jevlint preset --help` list every
preset with examples, and `jevlint preset list` prints them grouped by the command they serve.

Pick presets for one run by naming them after `audit`, or with `--preset`. Either replaces the
configured presets for that run only:

```sh
jevlint audit security            # just the security preset
jevlint audit security solid src  # two presets, on src only
jevlint audit --preset clean-code
```

A name after `audit` counts as a preset only when no file or directory of that name exists, so
`jevlint audit solid` still audits a directory called `solid` and prints a note saying so.

Set the presets every audit uses with `jevlint preset default`, which writes `presets` in your user
config, or in `jevlint.toml` with `--repo`. With no names, it lets you pick in a terminal, and in a
pipe it prints the current ones. `jevlint preset list` marks them with `*`.

```sh
jevlint preset default security,readable-code
jevlint preset default --repo solid
jevlint init --preset security    # choose them when creating the config
```

The `presets` key in `jevlint.toml` wins over your user config, as every repository setting does.

## Built-in presets

| Preset | Inspired by | Checks |
| --- | --- | --- |
| `readable-code` | _The Art of Readable Code_, Boswell and Foucher | Informative names, useful comments, simple control flow, time to understand |
| `clean-code` | _Clean Code_, Robert C. Martin | Small focused functions, one abstraction level, honest error handling |
| `solid` | SOLID principles, Robert C. Martin | Single responsibility, open/closed, substitution, interface segregation, dependency inversion |
| `software-design` | _A Philosophy of Software Design_, John Ousterhout | Deep modules, information hiding, general-purpose interfaces |
| `code-smells` | _Refactoring_, Martin Fowler | Long parameter lists, feature envy, primitive obsession, shotgun surgery signals |
| `clean-architecture` | _Clean Architecture_, Robert C. Martin | Dependency direction, boundaries, framework independence |
| `kiss-dry-yagni` | Common engineering maxims | Simplicity, duplication, speculative generality |
| `documentation` | Common API documentation practice | A purpose for each file, doc comments on exported code, stated contracts, doc comments that match the code, TODOs with a reason |
| `security` | Common secure coding guidance | Input validation, injection, secrets in source, access checks, safe failure, cryptography. Patterns flag `eval`, `innerHTML` and `shell=True` |
| `architecture-codebase`, `architecture-directory`, `architecture-class` | Common design guidance | One preset per perspective. Used only by [`jevlint architecture`](architecture-review.md) |
| `change-intent` | Common code review practice | Whether a change does what its message says and keeps to the repository's instructions. Used only by [`--intent`](cli.md#judging-a-change-with---intent) |

`readable-code` is the default. Each preset is an independent paraphrase of ideas. None reproduces
text from these works, and none is affiliated with or endorsed by their authors or publishers.

## Tuning

Use `[weights]` to change a question's importance. `0` disables it.

```toml
[weights]
"readable-code.naming" = 3
"solid.interface-segregation" = 0
```

## Writing a preset

`jevlint preset new house-style` writes a valid starting file to your user presets and opens it in
`$VISUAL` or `$EDITOR`. `--from security` starts from a copy of another preset, `--repo` writes into
`.jevlint/presets/` for the team, and `--no-edit` only writes the file. When the editor closes, the
file is checked, and a mistake is reported with its key.

`jevlint preset edit <name>` opens an existing preset the same way. A built-in one is copied to your
user presets first, or to `.jevlint/presets/` with `--repo`, and the copy then takes its place
everywhere. Remove the copy with `jevlint preset remove` to go back to the built-in.
`--path` prints the file instead of opening it, and `jevlint preset show <name> --toml` prints its TOML.
Leave out the name, as in `jevlint preset edit`, to pick it from a list.

Or write the file by hand. Create `house-style.toml`:

```toml
name = "house-style"
description = "How we write services"
source = "Internal engineering handbook"

[[questions]]
id = "boundary-validation"
type = "score"
title = "External input is validated at the boundary"
instructions = "How consistently does this file validate data arriving from outside the process?"
levels = [
  "External data is used with no validation",
  "Some inputs are validated",
  "Almost all inputs are validated",
  "All inputs are validated at the boundary, or none arrive here",
]
weight = 2
fix = "Validate external input once, at the point where it enters the system."

[[questions]]
id = "hidden-global-state"
type = "boolean"
title = "No hidden global state"
instructions = "Does this file read or change mutable global state?"
good = false
fix = "Pass state explicitly through parameters."

[[patterns]]
id = "no-any-cast"
language = "typescript"
pattern = "$X as any"
message = "Avoid casting to any"

[[rules]]
id = "catch-hides-failure"
language = "typescript"
pattern = "try { $$$ } catch ($E) { $$$ }"
question = "Does this catch block swallow a failure the caller needed to know about?"
message = "This catch hides a failure"
fix = "Rethrow it, or return an error the caller must handle."
```

The top-level `used_by` key says which command the questions are written for: `audit` (the default),
`architecture` or `intent`. It only decides where `preset list`, `--help` and the pickers show the
preset, so a preset for `jevlint architecture` does not appear among the choices for audits.

### Question fields

| Field | Required | Description |
| --- | --- | --- |
| `id` | Yes | Letters, digits, `-` and `_`. Unique in the preset |
| `type` | Yes | `score` or `boolean` |
| `title` | Yes | Short statement of the good state, shown in reports |
| `instructions` | Yes | The question for the model |
| `fix` | Yes | Advice given to coding agents |
| `levels` | `score` | 2 to 10 descriptions, ordered **worst to best** |
| `good` | `boolean` | The answer a clean file gives |
| `weight` | No | Relative importance. Default 1 |

### Writing good questions

- Ask about one thing per question.
- Describe observable features of the code, not intentions.
- Make adjacent levels clearly different.
- Allow for files where the question does not apply, as the last level above does.
- Test on a file you already consider good and a file you consider bad, and
  [keep them as fixtures](#testing-a-question).

## Testing a question

A question is a guess until it separates code you know is good from code you know is bad, and it can
stop doing so when a provider updates a model. Fixtures give you proof of the first and an alarm for
the second. jevlint ships none, because a built-in fixture could not be calibrated against your
provider and model.

Put them in a directory named after the question's full id:

```
.jevlint/fixtures/
└── house-style.boundary-validation/
    ├── good-parsed-at-entry.ts
    ├── bad-raw-request-body.ts
    └── bad-validated-too-late.py
```

Files are named `good-*.<ext>` or `bad-*.<ext>`, and anything else there is ignored. Fixtures are
never audited themselves, and a symlink among them must stay inside the repository.

1. Write fixtures for the question, ideally a clear case and a close call on each side.
2. Run `jevlint test house-style.boundary-validation`. A `good` file must reach compliance 0.7, and a
   `bad` one must stay below it, the line below which reports call an answer weak.
3. If one fails, rewrite the question or its levels, not the fixture, and run it again.
4. Run `jevlint test --record` and commit `.jevlint/calibration.json`. It holds the provider, the
   model and each fixture's compliance, with no timestamps, so it only changes when an answer does.
5. [Run `jevlint test --drift` on a schedule](ci.md#notice-when-a-model-moves). It asks again, ignoring
   the cache, and exits 1 if a fixture moved by 0.1 or more, or by `--drift-limit`.

After a move, read the fixtures that moved. If the new answers are still right, record them. If not,
fix the question, or pin the model in `provider.model`.

Each fixture is asked only its own question, while `audit` asks all of a file's questions in one
request. A model may answer a little differently in the two, so fixtures prove a question works, not
what a file will score. The questions must be active: add the preset to `presets`, and leave its
weight above 0. Only preset questions can be tested. See [`jevlint test`](cli.md#jevlint-test-questions).

### Semantic rules

A `[[patterns]]` entry reports every match. A `[[rules]]` entry first asks a model about each match,
so it can tell a catch block that hides a failure from one that handles it. ast-grep picks the code,
your sentence judges it, and a hit gets a line number. Rules work in a preset and in `jevlint.toml`.

| Field | Required | Description |
| --- | --- | --- |
| `id` | Yes | Letters, digits, `-` and `_`. Unique in the preset or config, and not a built-in finding such as `nesting` |
| `language` | Yes | As in `[[patterns]]`. `tsx` and `typescript` are separate |
| `pattern` | Yes | [ast-grep pattern](extending.md#ast-patterns) that picks the code |
| `question` | Yes | Asked about each match. **Yes means a violation** |
| `message` | Yes | The finding's text |
| `fix` | Yes | Advice given to coding agents with each hit |
| `threshold` | No | Report a match at or above this probability, from 0 to 1. Default 0.8 |

- The model sees only the matched text, with no path and no surrounding code, so ask what that text
  can answer. Pick a pattern as wide as the question needs.
- A hit is an AST finding: it has the rule's `id`, costs 5% of the AST score like a
  [pattern match](scoring.md#ast-score), and appears in `explain`, `prompt`, `pr` and `commits`.
- Each match is one request. Identical matches share a [cached](caching.md) answer, and changing
  `threshold`, `message` or `fix` costs nothing.
- At most [`max_rule_matches`](configuration.md#top-level-keys) matches per rule are judged in a
  file, in source order. A warning says when the rest were skipped.
- Rules need a grammar and a model. They do not run with `--ast-only`, with no key, or on a file with
  a whole-file [pin](scoring.md#pinning-scores).
- A pattern that ast-grep rejects is an error naming the rule. A failed request is a warning on the
  file, and its match counts as no hit.

## Installing presets

For all your repositories:

```sh
jevlint preset add ./house-style.toml
```

This copies the file to `~/.config/jevlint/presets/`. To share it with your team, use `--repo`,
which copies it to `.jevlint/presets/`, and commit that directory. A symlink in that directory must stay
inside the repository.

When names collide, the order of preference is repository, user, built-in.

```sh
jevlint preset list
jevlint preset show house-style
jevlint preset edit house-style
jevlint preset remove house-style
```
