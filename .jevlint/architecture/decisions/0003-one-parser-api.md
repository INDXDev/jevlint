---
id: one-parser-api
title: One tree-sitter API for every language, with a lexical fallback
date: 2026-11-05
status: accepted
components: [ast-metrics]
enforced_by: [ast-grep-only-in-analysis]
evidence: [docs/architecture.md:168-180, src/ast/languages.ts:24-34, commit:e5d06f4, commit:5884c7f]
---

Dated from commit e5d06f4, the initial release, which chose ast-grep and the lexical fallback.
Commit 5884c7f, the same day, shipped the parsers as files.

### Context

Each `@ast-grep/lang-*` package is about 11 MB of prebuilt parsers. Its install script makes pnpm
warn on every install.

### Decision

Use ast-grep, so a language is a table of node kinds. Bundle only Python, Go and Rust parsers,
copied into `dist/parsers/` at build time, and keep the grammar packages as devDependencies
(commit 5884c7f, `src/ast/languages.ts:24-34`). Every other language gets `src/ast/generic.ts`, a
one-pass keyword and indentation reader.

### Consequences

The install stays small and quiet. Other languages get approximate metrics
(`AstResult.approximate`) and no architecture facts.

### Alternatives

A separate analyser per language, or shipping more grammars. Both are named and rejected in
`docs/architecture.md:168-180`.
