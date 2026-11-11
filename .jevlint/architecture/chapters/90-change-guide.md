---
title: Change guide
evidence: [AGENTS.md, CONTRIBUTING.md, docs/extending.md, docs/architecture.md:50-58, src/node-version.ts:3-8, src/config.ts:17-19, src/decision/decide.ts:61-67, src/architecture/externals.ts:1, src/ast/languages.ts:11-15, src/architecture/collect.ts:25-26, src/commands/shared.ts:19-20]
---

Read this before you start a task. Every row ends with `pnpm check`, which runs lint, typecheck,
tests and build, the same four steps as CI. Run one test file with `pnpm vitest run test/<module>.test.ts`.
Run the CLI from source with `pnpm dev <command>`. Change `docs/` in the same change, and add a
`CHANGELOG.md` "Unreleased" entry when users will notice.

| To add or change | Change these files | Follow this rule | Check with |
| --- | --- | --- | --- |
| A principle or question | `presets/<name>.toml` (paraphrase the source, never copy it); `presets/full.toml` if it belongs in the default | Presets are data. No code | `jevlint preset show <name>`, fixtures in `.jevlint/fixtures/<preset>.<id>/`, `jevlint test` |
| A language | The node-kind table in `src/ast/languages.ts`, and for a new grammar the build copy in `tsdown.config.ts` | Languages are a table. Without a grammar, `generic.ts` applies | `test/ast.test.ts`, `pnpm dev audit --ast-only` |
| A provider | `src/decision/providers.ts`, `ProviderName` in `src/types.ts`, the schema in `src/config.ts`, `KEY_ENV` in `src/credentials.ts`, `src/decision/pricing.ts` | Only `src/decision/` imports `ai` or `@ai-sdk/*` (`ai-sdk-only-in-decision`). Mock providers in tests | `test/providers.test.ts`, `jevlint architecture check --static` |
| A known external system for the facts | One row in `src/architecture/externals.ts` | Data, not code | `test/architecture-facts.test.ts` |
| A CLI command or flag | `src/commands/<name>.ts`, the table in `src/cli.ts`, `docs/cli.md` | Commands stay thin. Results go to stdout, everything else to stderr (`PROMPT_IO`). Throw `UserError` for user mistakes. Respect the exit codes 0, 1 and 2 | `test/commands.test.ts`, copying its `jevlintAt` helper with a temporary `HOME` and `XDG_*` |
| A config setting | The schema and `DEFAULTS` in `src/config.ts`, `docs/configuration.md` | Keep `snake_case`. A key naming an endpoint, command or user path goes in `USER_ONLY_KEYS` | `test/config.test.ts` |
| A scoring formula | `src/scoring.ts`, `docs/scoring.md` | Pure, with no I/O (`scoring.pure`). It runs after the cache, so never fold scores into cached data | `test/scoring.test.ts` |
| What is sent to a model | The caller, and `decisionKey` in `src/decision/decide.ts` if the request gains an input | The cache key must cover provider, model, endpoint, questions and content. Update `docs/security.md` | `test/decide.test.ts`, `jevlint audit --dry-run` |
| A JSON report field | `src/types.ts`, `docs/json-output.md` | Report shapes are public. `--json` keeps the original text | The module's test and `test/commands.test.ts` |
| Terminal output | `src/report.ts`, `src/architecture/terminal.ts` or `src/spec/terminal.ts` | Print repository text through `withoutControlCharacters` or `withoutEscapes`. Only `cli` and `commands` call `console` (`terminal-only-interface`) | `test/report.test.ts` |
| A file jevlint writes | The writing module | Use `writeFileAtomic`. Refuse links that lead outside the repository (`assertInRepo`). Read with `readRegularFile` | `docs/security.md` review, tests for a planted symlink |
| A git call | `src/git.ts` only | Use `git()`. Prefer plumbing (`ls-tree`, `cat-file`, `diff-tree`). Refuse revisions starting with `-` | `test/git.test.ts` |
| A command jevlint runs | `src/git.ts`, `src/agent.ts`, `src/fixers.ts` or a command | No shell, with a timeout. Only those components may import `node:child_process` (`processes-in-few-places`) | `jevlint architecture check --static` |
| `quickfix.after` or trust | `src/fixers.ts`, `src/trust.ts`, `src/commands/trust.ts` | Repository commands run only after an approval of their current fingerprint. `--yes` never approves | `test/fixers.test.ts`, `test/trust.test.ts` |
| The architecture outline shape | `src/architecture/extract.ts`, `src/architecture/collect.ts` | Bump `OUTLINE_VERSION` so stale cache entries are not read | `test/architecture-facts.test.ts` |
| An SSOT rule kind or view field | `src/architecture/load.ts` (schema), `src/architecture/conformance.ts` or `views.ts`, `docs/architecture-reference.md` | The SSOT holds globs, package names, ast-grep patterns and prose only, never a command, URL or outside path | `test/architecture-load.test.ts`, `test/architecture-conformance.test.ts` |
| A component's files or dependencies | The code, then `.jevlint/architecture/components/<id>.yaml` | `depends_on` is an allowlist. Layers point down | `jevlint architecture check --static`, then `jevlint architecture drift --static` |
| The Node version floor | `src/node-version.ts`, `src/cli.ts`, `engines` in `package.json`, `.node-version`, `test/node-version.test.ts`, `README.md`, `CONTRIBUTING.md`, `docs/getting-started.md` | Keep them all in step | `test/node-version.test.ts` |

### Things not to do

- Do not add or edit `// jevlint-score` comments to raise a score.
- Do not clean up `examples/messy-shop`. It is bad on purpose.
- Do not call a real provider in a test. Mock `src/decision/providers.ts` or stub `fetch`.
- Do not use enums, namespaces or parameter properties. Node strips types to run `src/` directly,
  so imports carry `.ts` and type-only imports use `import type`.
