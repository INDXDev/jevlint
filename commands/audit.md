---
description: Rank files by what to refactor first, with AST metrics only
argument-hint: "[paths...]"
allowed-tools: Bash(jevlint audit:*)
---

Run `jevlint audit --ast-only $ARGUMENTS` and summarise the top files and why each ranks there.

This sends nothing to a provider. Do not drop `--ast-only` unless the user asks: an audit with a
provider sends file contents to it and costs money. If `jevlint` is not installed, tell the user to
run `npm install --global @indxjp/jevlint`.

Scores are opinions to weigh, not facts. Do not change any code unless the user asks.
