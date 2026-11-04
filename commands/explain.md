---
description: Show every finding and score for one file
argument-hint: "<file>"
allowed-tools: Bash(jevlint explain:*), Bash(jevlint audit:*)
---

Explain what jevlint thinks of `$ARGUMENTS`.

`jevlint explain` sends the file to the configured provider when a key is set, so ask before running
it unless the user has already agreed. To stay on this machine, run
`jevlint audit $ARGUMENTS --ast-only --json` and read the file's `ast.findings`.

Say which findings matter and which you would leave alone. Do not add or change `jevlint-score`
comments.
