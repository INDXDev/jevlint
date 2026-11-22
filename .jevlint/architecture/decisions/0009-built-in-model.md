---
id: built-in-model
title: A built-in model behind the decision API, with its own parser
date: 2026-11-22
status: accepted
components: [decision]
unenforceable: "That the features match the training code is a property of their values, which test/local.test.ts checks, not of imports or calls."
evidence: [docs/architecture.md:193-207, docs/providers.md, models/README.md, src/decision/local.ts, src/decision/local/parse.ts]
---

### Context

With no API key, every model question went unanswered and a run fell back to AST metrics alone. A
decision model is too large to ship, but its answers about many files can be learned by a much
smaller one.

### Decision

Ship gradient-boosted trees in `models/`, trained on a large decision model's answers to the
questions of `readable-code`, `clean-code` and `security`, as the `local` provider.
`src/decision/local.ts` implements the AI SDK's decision model contract, so the cache, scoring and
commands work unchanged. Only `audit()` accepts it, and `answerable()` keeps the questions it does
not know out of its requests.

Its features are a line-for-line port of the training code, parsed with web-tree-sitter and the
grammar versions used in training. This is a second parser beside ast-grep
([one-parser-api](0003-one-parser-api.md)), because ast-grep's bundled grammars differ from the
training ones, and a feature that differs sends a file down another branch. Its grammars ship as
`.wasm` files in `dist/grammars/`, as the ast-grep parsers do.

### Consequences

A run with no key scores the 20 questions it knows on the user's machine. The package grows by
about 30 MB. `src/decision/local/features.ts` cannot be refactored, and a question reworded in those
presets loses its answer until the model is retrained, which `test/local.test.ts` reports.

### Alternatives

Computing the features from ast-grep's trees, rejected because they would not match training.
Downloading the model on first use, rejected because the run would need the network.
