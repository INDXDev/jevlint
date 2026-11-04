# Contributing to jevlint

Thanks for helping. Small, focused pull requests are the easiest to review.

## Set up

You need Node.js 24.22.1 or later and pnpm. `.node-version` pins the version we develop on, and
`corepack enable` gives you the right pnpm.

```sh
pnpm install
pnpm check     # lint, typecheck, test and build
```

| Command | What it does |
| --- | --- |
| `pnpm dev audit --ast-only` | Run the CLI from source, with no build or API key |
| `pnpm test:watch` | Re-run tests as you edit |
| `pnpm format` | Fix formatting and imports |
| `pnpm demo` | Re-record the README GIF. Needs [VHS](https://github.com/charmbracelet/vhs) |

`examples/messy-shop` is bad on purpose, so it makes a good test subject:

```sh
cd examples/messy-shop && node ../../src/cli.ts audit --ast-only
```

VS Code picks up the recommended extensions and format-on-save from `.vscode/`.

## CI

CI runs the same four steps as `pnpm check`, so if that passes locally, CI should too. Every step
runs even when an earlier one fails, so one push shows all the failures, and they appear as
annotations on the pull request's diff. A new push cancels the check it replaces.

## Principles

- **Less code wins.** Prefer deleting code to adding it, and a reputable library to a hand-written
  version. Do not add a dependency for a few lines.
- **Prefer data to code.** New principles belong in presets, and new languages in a table.
- **Docs change with behaviour.** Update `docs/` in the same pull request.
- **Test the logic.** Scoring, config and metric changes need tests. Tests must not call real
  providers.

Read the [architecture overview](docs/architecture.md) first.

## Presets

Built-in presets must be your own paraphrase of an idea. Do not copy text from books or articles.
Name the source of the idea in the `source` field.

## Pull requests

1. Open an issue first for anything large.
2. Run `pnpm check`.
3. Add an entry under "Unreleased" in `CHANGELOG.md` if users will notice the change.

By contributing, you agree that your work is licensed under the [MIT License](LICENSE).
