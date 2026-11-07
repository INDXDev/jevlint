# Spec reference

This page specifies `jevlint spec`: where the spec lives, its file format, the questions jevlint asks,
and the results it returns. It is the single source of truth for the feature. For a guide, read
[Spec-driven development](spec-driven-development.md) first.

## Location

| Setting | Default | Meaning |
| --- | --- | --- |
| `spec.dir` | `".jevlint/spec"` | Directory holding the spec, relative to the root |
| `spec.docs` | `["README.md", "docs/**/*.md", "docs/**/*.html"]` | Globs, relative to the root, for the documents the spec is compiled from and compared with |

Both may be set in `jevlint.toml` or in user config. `spec.dir` must stay inside the root, and a
symlink that leads out of it is refused.

```
.jevlint/spec/
├── index.yaml          the project: description and project checklist
└── features/
    ├── login.yaml      one feature each, named after its id
    └── admin.yaml
```

## `index.yaml`

```yaml
version: 1
name: Shop
description: >
  An online shop: customers browse a catalogue, pay by card and get their order by post.
  Staff manage stock and refunds in an admin panel.
checklist:
  - id: no-secrets-in-logs
    text: Logs never contain passwords, session tokens or card numbers.
    source: docs/security.md
```

| Key | Type | Required | Meaning |
| --- | --- | --- | --- |
| `version` | `1` | Yes | The format version. Only `1` exists |
| `name` | string | Yes | The project's name |
| `description` | string | Yes | What the project is, in a paragraph. Every routing question includes it |
| `checklist` | list of items | No | Items every file and document is judged against. Defaults to none |

## `features/<id>.yaml`

```yaml
id: login
title: Login
summary: Signs customers in with email and password, and keeps them signed in.
checklist:
  - id: lockout
    text: Five failed sign-ins in a row lock the account for 15 minutes.
    source: docs/auth.md
  - id: hashing
    text: Passwords are stored only as Argon2id hashes.
    source: docs/auth.md
```

| Key | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | id | Yes | Must equal the file name without `.yaml` |
| `title` | string | Yes | A short name for people |
| `summary` | string | Yes | One or two sentences that tell this feature apart from the others. The routing question shows it |
| `checklist` | list of items | Yes | At least one item |

## Items

| Key | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | id | Yes | Unique within its file |
| `text` | string | Yes | One checkable statement, in the present tense |
| `source` | string | No | Where the item came from, such as `docs/auth.md` or `docs/auth.md#lockout`. For people only: jevlint never reads it |

An item's full id is `<feature>.<id>`, or `global.<id>` for the project checklist.

## Validation

Every `spec` command loads the spec the same way. At the first invalid file it stops with exit code
2 and names every problem in that file. `jevlint spec list` only loads and prints it, so an agent can
use it to check its work.

- An id uses only lowercase letters, digits and `-`, and starts with a letter or digit.
- `global` is reserved and cannot be a feature id.
- Unknown keys are errors, so a typo does not silently drop a field.
- Only `index.yaml` and `features/*.yaml` are read. Any other file in the directory is ignored.
- A missing `index.yaml` means there is no spec yet. `compile` carries on, and every other command
  stops and says to run `jevlint spec compile`.
- There must be at least one feature, and at most 255, the limit of one choice question.
- Every file must be a regular file inside the root. YAML anchors and aliases are limited, so a
  crafted file cannot expand without bound.

## Compile

`jevlint spec compile [docs...]` prints a Markdown prompt for a coding agent, or copies it with
`--copy`. It makes no network call and writes no file.

The prompt contains:

1. The goal: write or update the spec in `spec.dir` from the listed documents.
2. The documents: the paths matching `spec.docs`, or the paths given on the command line. Paths only,
   never contents: the agent reads them itself.
3. The current spec, if one loads: the path of each file, with the instruction to update in place and
   keep existing ids for items whose meaning did not change.
4. This format: the layout, the keys and the validation rules above.
5. Rules for good items, as in the guide.
6. How to finish: run `jevlint spec list` until it succeeds, change nothing outside `spec.dir`, do
   not commit, and summarise the features and the number of items.

An invalid existing spec does not stop `compile`: the prompt says the spec failed to load and why, so
the agent can repair it.

## Check

`jevlint spec check [paths...]` judges code files. The files are those `audit` would discover, with
the same `include`, `exclude`, `.gitignore` and built-in exclusions, narrowed to `paths` when given.

Each file takes two requests to the decision model. The state of both is the file's source, with
`jevlint-score` comments removed and cut at `max_file_chars`.

**Request 1: route and project checklist.**

- `route`, a choice question. The options are every feature id, plus `global`.
  - Instructions: `This file is part of <name>: <description> Which one feature of it does this file
    implement? Choose global if it is shared code, tooling, configuration or tests that implement no
    single feature.`
  - Each feature option is described by `<title>: <summary>`. `global` is described by `No single
    feature: shared code, tooling, configuration or tests.`
- One choice question per project checklist item, as below.

**Request 2: the feature checklist.** Sent only when `route` chose a feature. One choice question per
item of that feature.

Each item question is a choice with three options:

| Option | Description given to the model |
| --- | --- |
| `satisfies` | The file implements or follows this requirement |
| `violates` | The file contradicts this requirement, or implements it wrongly |
| `not-applicable` | The file does not deal with what this requirement is about |

Its instructions are `Judge this file against one requirement of <scope>: "<text>"`, where `<scope>`
is `the whole project` or `the <title> feature`.

**Results.**

- A file's verdict on an item is the option the model chose, and its confidence is the probability
  the model gave that option, or 1 when the provider reports none.
- A file's score is satisfied items over satisfied plus violated items, on the configured
  `scoring.scale`. A file with no applicable item has no score.
- Files are listed by the number of violations, most first, then by score, lowest first.
- An item is **unimplemented** when no file satisfies it. This is worked out only when the run covered
  the whole repository, because a narrowed run cannot see every file.
- The run **fails**, with exit code 1, when any item is violated or unimplemented.

A provider error on one file becomes a warning on that file, as in an audit. A bad key stops the run.

## Drift

`jevlint spec drift [docs...]` judges documents. They are the files matching `spec.docs`, narrowed to
the paths given, with the same `.gitignore`, `exclude` and built-in exclusions as discovery. `include`
does not apply, and the source-extension filter does not apply, so Markdown is read.

Each document takes two requests.

**Request 1: route.** The state is the document. One choice question, `route`, with every feature id
plus `global`.

- Instructions: `This document is part of <name>: <description> Which one feature does this document
  describe? Choose global if it describes the project as a whole, or no single feature.`
- Options are described as for `check`, with `global` as `The project as a whole, or no single
  feature.`

**Request 2: compare.** The state is the routed checklist, then the document:

```
===== Checklist: <scope> =====
- <full id>: <text>
...

===== Document: <path> =====
<document>
```

The checklist comes first, so truncation cuts the document, never the checklist. Questions:

- One choice question per item of the routed checklist (the project checklist for `global`):

  | Option | Description given to the model |
  | --- | --- |
  | `agrees` | The document states this requirement, or something that means the same |
  | `contradicts` | The document states something that conflicts with this requirement |
  | `absent` | The document does not mention what this requirement is about |

  Instructions: `Compare the document with checklist item <full id>: "<text>"`.
- `uncovered`, a boolean question: `Does the document state a specific, checkable requirement that
  no item in the checklist covers?` Its answer is the probability of yes.

**Results.**

- A **contradiction** is any item a document contradicts.
- A document is **uncovered** when `uncovered` is 0.5 or more.
- An item is **unbacked** when it is `absent` from every document routed to its checklist.
- A feature is **undocumented** when no document is routed to it.
- Unbacked items and undocumented features are worked out only when the run covered every document.
- The run **fails**, with exit code 1, when it finds any of the four.

## JSON output

`spec check --json`:

```json
{
  "root": "/path/to/repo",
  "specDir": ".jevlint/spec",
  "provider": "typesafe",
  "model": "jev-latest",
  "scale": 100,
  "complete": true,
  "files": [
    {
      "path": "src/auth/session.ts",
      "feature": "login",
      "featureConfidence": 0.91,
      "score": 50,
      "items": [
        { "id": "login.lockout", "text": "...", "verdict": "violates", "confidence": 0.84 }
      ],
      "warnings": []
    }
  ],
  "violations": 3,
  "unimplemented": [{ "id": "checkout.receipt", "text": "..." }],
  "usage": { "inputTokens": 0, "estimatedCostUsd": 0, "cacheHits": 0, "modelCalls": 0 },
  "warnings": []
}
```

- `complete` is false when paths narrowed the run. `unimplemented` is then empty.
- `feature` is `"global"` for a file routed to no feature, and `null` when the file got no answer.
- `score` is `null` for a file with no applicable item.
- `items` lists every judged item, project items first.

`spec drift --json`:

```json
{
  "root": "/path/to/repo",
  "specDir": ".jevlint/spec",
  "provider": "typesafe",
  "model": "jev-latest",
  "complete": true,
  "docs": [
    {
      "path": "docs/auth.md",
      "feature": "login",
      "featureConfidence": 0.95,
      "items": [
        { "id": "login.lockout", "text": "...", "verdict": "contradicts", "confidence": 0.8 }
      ],
      "uncovered": 0.7,
      "warnings": []
    }
  ],
  "contradictions": 1,
  "uncovered": ["docs/auth.md"],
  "unbacked": [{ "id": "login.hashing", "text": "..." }],
  "undocumented": ["admin"],
  "usage": { "inputTokens": 0, "estimatedCostUsd": 0, "cacheHits": 0, "modelCalls": 0 },
  "warnings": []
}
```

`uncovered` on a document is a probability from 0 to 1. On the report it lists the documents at or
above 0.5.

`spec list --json` prints the loaded spec: `{ "dir", "index", "features" }`, with the keys of the
YAML files.

## Security

The repository is untrusted, so the spec is too.

- The spec directory and every file in it must resolve inside the root. Each file is read as a
  regular file, so a planted pipe or device cannot hang the run.
- The YAML is parsed with a limit on aliases and validated with a strict schema.
- Feature ids come from validated file contents and are never used to build a path.
- Item texts, titles and paths are printed through `withoutControlCharacters`, so they cannot
  inject terminal escapes. In the compile prompt each sits on its own line, so it cannot add
  headings for the agent to obey. `--json` keeps the original text.
- Document discovery keeps the built-in secret exclusions, so `spec.docs = ["**/*"]` still never
  sends `.env` or a key file.
- Cache keys cover the provider, model, endpoint, every question with its options and the state, as
  for any other decision.
