# jevlint

A model-based linter CLI in TypeScript. It scores every file with AST metrics and decision models,
then ranks what to refactor first. Published to npm with a library API in `src/index.ts`.

This file holds what an agent needs and cannot guess. For the rest, read
[docs/architecture.md](docs/architecture.md) (layers, modules, design decisions) and
[CONTRIBUTING.md](CONTRIBUTING.md). `docs/agents.md` is unrelated: it is the user guide to handing
work to coding agents.

## Commands

```sh
pnpm install
pnpm check                             # lint, typecheck, test, build. CI runs the same four as steps
pnpm vitest run test/scoring.test.ts   # one test file
pnpm format                            # Biome: fix formatting and imports
pnpm dev audit --ast-only              # run the CLI from source: no build, key or network
```

Node runs `src/` directly by stripping types, so TypeScript must be erasable: no enums, namespaces
or parameter properties. Imports use the `.ts` extension, and type-only imports use `import type`.

`jevlint` refuses to run on an unpatched Node. To change the floor, update `src/node-version.ts`,
`src/cli.ts`, `engines` in `package.json`, `.node-version`, its test, and the versions in `README.md`,
`CONTRIBUTING.md` and `docs/getting-started.md`.

## Rules the code depends on

- Dependencies point down the layers in [docs/architecture.md](docs/architecture.md#layers):
  `cli.ts` and `commands/` at the top, `types.ts` at the bottom. Commands stay thin; logic goes in
  core modules.
- `scoring.ts` is pure: no I/O.
- Only `src/decision/` imports `ai` or `@ai-sdk/*`.
- Only the interface layer writes to the terminal. Core modules return data or throw, and the
  library API stays silent.
- Throw `UserError` for anything the user can fix. Any other error is reported as a bug.
- Exit codes are a contract: 0 success, 1 a check failed (below `fail_under`, `audit --new`,
  `hook --staged`, `test`), 2 usage, config or gate error. `hook` uses 2 to reach Claude Code.
- stdout carries only results, so `--json` and piped prompts stay parseable. Warnings and prompts go
  to stderr (`PROMPT_IO` in `src/commands/shared.ts`).
- Plain functions and data. `UserError` is the only class, because it needs `instanceof`.
- Config keys stay `snake_case`, as written in TOML, with no mapping layer.
- Give every exported symbol a short doc comment. Inline comments explain why, never what.
- New principles go in `presets/`, and new languages and providers in their tables. See
  [docs/extending.md](docs/extending.md). Built-in presets must paraphrase, never copy, their source.

## The repository being audited is hostile

Treat every path, file, config and preset in it as attacker-controlled. Before changing discovery,
config, git, output or file writes, read [docs/security.md](docs/security.md). In particular:

- Print repository text through `withoutControlCharacters` or `withoutEscapes` from `src/report.ts`.
  `--json` keeps the original text.
- Write files with `writeFileAtomic` from `src/config.ts`, which replaces a planted symlink rather
  than writing through it.
- Run git through the `git()` helper in `src/git.ts`, which disables what a repository's config
  could execute.
- A new setting that names an endpoint, a command or a path on the user's machine belongs in
  `USER_ONLY_KEYS` in `src/config.ts`, so a repository's `jevlint.toml` cannot set it. The one
  exception is `quickfix.after`, which runs a repository's commands only once `src/trust.ts`
  says the user approved them as they are now.
- A model cache key must cover everything that changes the answer: provider, model, endpoint,
  questions and content. Only raw answers are cached, and scoring runs after the cache.

## Tests

- Tests are named after their module, as `test/<module>.test.ts`.
- Never call a real provider. Mock `src/decision/providers.ts` or stub `fetch`.
- CLI tests spawn `src/cli.ts` with a temporary `HOME` and `XDG_*`, so they cannot read real keys.
  Copy the `jevlintAt` helper in `test/commands.test.ts`.
- Scoring, config and metric changes need tests.

## When you change behaviour

- Update `docs/` in the same change: flags in `docs/cli.md`, JSON fields in `docs/json-output.md`,
  settings in `docs/configuration.md`, what leaves the machine in `docs/security.md`.
- Add an entry under "Unreleased" in `CHANGELOG.md` if users will notice.
- Do not add or edit `// jevlint-score` comments to raise a score. They record a human's decision
  to accept one.
- `examples/messy-shop` is bad on purpose. Do not clean it up.
