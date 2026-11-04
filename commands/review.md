---
description: Review what a pull request or recent commits made worse
argument-hint: "[pull request number | revision]"
allowed-tools: Bash(jevlint pr:*), Bash(jevlint commits:*)
---

Review what a change made worse, with AST metrics only.

- If `$ARGUMENTS` is a number, run `jevlint pr $ARGUMENTS --ast-only`. This needs the `gh` CLI.
- Otherwise run `jevlint commits $ARGUMENTS --count 5 --ast-only`.

Report only what got worse, by file and line, and name the commit or pull request. Do not drop
`--ast-only` unless the user asks: a model run sends each changed file, on both sides of the change,
to the provider. Only run `jevlint pr` in a clone the user made themselves, because it runs
`git fetch` and `gh`.
