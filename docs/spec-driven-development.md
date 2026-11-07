# Spec-driven development

`jevlint spec` keeps three things in agreement: what your documents say, a checklist of what they
require, and what your code does. This page is the guide. The exact file format and the questions
jevlint asks are in the [spec reference](spec-reference.md).

## The idea

A project describes itself twice: once in prose, in its README and `docs/`, and once in code. The two
drift apart. Prose is too loose to check code against, and code is too detailed to check prose
against. So `jevlint spec` adds a third thing between them: a **spec**, a checklist of short,
checkable requirements kept as YAML files in your repository.

```
        documents  ──── compile ───▶  spec (checklist)  ◀──── check ────  code
            ▲                               │
            └──────────── drift ────────────┘
```

| Thing | Who writes it | What it is for |
| --- | --- | --- |
| Documents | People | Explaining the system to people |
| Spec | A coding agent, from the documents, reviewed by people | The single source of truth that a decision model can check |
| Code | People and agents | Doing what the spec says |

Each arrow is one command:

| Command | Direction | What it does | Needs a model |
| --- | --- | --- | --- |
| `jevlint spec compile` | documents → spec | Prints a prompt that tells a coding agent to write or update the spec from your documents | No |
| `jevlint spec check` | spec → code | Asks, for every code file, which checklist items it satisfies or violates, and which items nothing implements | Yes |
| `jevlint spec drift` | spec ↔ documents | Asks, for every document, whether it agrees with the spec, and what it requires that the spec leaves out | Yes |

The spec is the part you keep clean. Documents can stay readable prose and code can stay code,
because every comparison goes through the checklist.

## Why a checklist, and why two levels

A decision model answers a fixed question about a piece of text well. It does not answer "is this
code correct?" well. So every requirement in the spec is one short statement that a model can judge
on its own: "Five failed sign-ins in a row lock the account for 15 minutes."

A real project has hundreds of such statements, and most of them say nothing about a given file. So
the spec has two levels:

- **The project checklist**, in `index.yaml`: what holds everywhere, such as "Logs never contain
  passwords or tokens", plus a one-paragraph description of the project.
- **Feature checklists**, one file per feature in `features/`, such as `login.yaml`, `admin.yaml` or
  `checkout.yaml`.

Every file is judged in two steps. First, one request asks which feature the file belongs to, as a
choice between your features, together with the project checklist. Then a second request judges the
file against that one feature's checklist. A login handler is never asked about the admin panel, so
the answers stay focused and the cost stays low.

## Get started

### 1. Point jevlint at your documents

By default the spec lives in `.jevlint/spec/`, and the documents it is compiled from are `README.md`
and the Markdown and HTML files under `docs/`. Change either in `jevlint.toml`:

```toml
[spec]
dir = ".jevlint/spec"
docs = ["README.md", "docs/**/*.md", "docs/**/*.html"]
```

### 2. Compile the spec with a coding agent

```sh
jevlint spec compile --copy
```

This copies a prompt that names your documents, describes the spec format, and tells the agent how
to write good checklist items. Paste it into Claude Code, Codex or any other coding agent. To compile
from only some documents, name them: `jevlint spec compile docs/auth.md`.

The agent writes `.jevlint/spec/index.yaml` and one file per feature, then runs `jevlint spec list`
to check that they load. jevlint never writes the spec itself. Compiling is a judgement call, and it
belongs with an agent you can watch and a person who reviews the diff.

Read the result as you would read a pull request. Items should be specific, checkable and true to
the documents. Commit the spec when you agree with it.

### 3. Check the code against the spec

```sh
jevlint spec check
```

You get every file that violates an item, worst first, and every item that no file satisfies:

```
Spec check: 3 violations in 2 files, 1 unimplemented item (.jevlint/spec)

  src/auth/session.ts                 login  (0.91)  score 50
    ✗ login.lockout       Five failed sign-ins in a row lock the account for 15 minutes.
  src/admin/users.ts                  admin  (0.88)  score 67
    ✗ admin.audit-log     Every change to a user's role is written to the audit log.
    ✗ global.no-secrets   Logs never contain passwords, tokens or card numbers.

Unimplemented: no file satisfies these items.
  checkout.receipt      A receipt email is sent after every successful payment.
```

Add `--copy` to also copy a prompt that asks a coding agent to fix the code, then paste it into the
agent. Or fix it by hand. Name paths to check only
part of the repository: `jevlint spec check src/auth`. A narrowed run cannot know what is
unimplemented, so it leaves that list out.

### 4. Check the documents against the spec

```sh
jevlint spec drift
```

This finds four kinds of drift:

| Drift | Meaning | Usual fix |
| --- | --- | --- |
| Contradiction | A document says something different from an item | Fix whichever is wrong, then recompile |
| Uncovered | A document states a requirement the checklist does not have | Recompile, so the item is added |
| Unbacked | No document states an item | Document it, or delete the item |
| Undocumented | No document describes a feature | Document the feature, or delete it |

`jevlint spec drift --copy` also copies a prompt that asks a coding agent to resolve each one.

### 5. Keep the three in agreement

When you change the documents, recompile. `jevlint spec compile` sees the existing spec and tells the
agent to update it in place and keep item ids stable, so history and reviews stay readable. When you
change the code, run `jevlint spec check`. Run both in CI:

```sh
jevlint spec drift && jevlint spec check
```

Both exit with 1 when they find a problem, so either can gate a pull request.

## Commands

| Command | Exit codes |
| --- | --- |
| `jevlint spec compile [docs...] [--copy]` | 0, or 2 if the spec does not load |
| `jevlint spec check [paths...] [--copy] [--json] [--no-cache]` | 0 clean, 1 a violation or an unimplemented item, 2 usage, config or spec error |
| `jevlint spec drift [docs...] [--copy] [--json] [--no-cache]` | 0 clean, 1 any drift, 2 usage, config or spec error |
| `jevlint spec list [--json]` | 0 if the spec loads, 2 if it does not |

`check` and `drift` need a decision model: there is no AST-only fallback, because every answer comes
from the checklist. See [Providers](providers.md) to set one up. Answers are cached like any other
jevlint answer, so a second run over unchanged files is free.

## What leaves your machine

`spec check` sends each code file, as `audit` does. `spec drift` sends each document together with
the checklist it is compared against. Both send the item texts and feature summaries as questions.
The same exclusions apply as for an audit: `.gitignore`, `exclude` and the built-in list of secret
files. See [Security and privacy](security.md).

## Tips for a good spec

- One item, one fact. "Passwords are hashed with Argon2id" is checkable. "Authentication is secure"
  is not.
- Write items about behaviour a reader can see in code: a value, a limit, a call, an order of steps.
- Give each feature a summary that tells it apart from the others. The routing question shows only
  the summaries, so two features that sound alike will be confused.
- Keep features coarse. Five to twenty features suit most projects. A file can belong to only one.
- Keep cross-cutting rules in the project checklist, not copied into every feature.
- Record where each item came from in `source`, so a reviewer can follow it back to the document.

## Limits

- A file is routed to one feature. A file that serves two features is checked against the more
  likely one. Split such files, or move the shared rule to the project checklist.
- The answers come from a model, so they can be wrong. Read a violation before acting on it, and use
  `--no-cache` to ask again.
- A long file or document is truncated at `max_file_chars`, as in an audit. HTML is sent with its
  tags, so a heavy generated page reaches that limit sooner than its text alone would.
