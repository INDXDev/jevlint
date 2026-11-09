# Getting started

This guide takes you from installation to a ranked refactoring list in about five minutes.

## Install

jevlint needs Node.js 24.22.1 or later (or 22.23.4, or 26.12.1, on those lines). Older releases have
known security holes, so jevlint refuses to run on them.

```sh
npm install -g @indxjp/jevlint
```

To keep it in your home directory instead of the global prefix:

```sh
npm install --prefix ~/.jevlint @indxjp/jevlint
echo 'export PATH="$HOME/.jevlint/node_modules/.bin:$PATH"' >> ~/.zshrc
```

To run it once without installing, use `npx @indxjp/jevlint audit`.

To install from a source checkout:

```sh
pnpm install && pnpm build && pnpm link --global
```

## Try it with no API key

AST analysis runs on your machine and sends nothing anywhere:

```sh
cd your-project
jevlint audit --ast-only
```

## Add a provider

A decision model adds judgement that an AST cannot provide. Store a key once for your user account:

```sh
jevlint auth set typesafe
```

The key goes in `~/.config/jevlint/credentials.toml`, readable only by you. If you already export
`TYPESAFE_AI_API_KEY`, you can skip this step and allow it when jevlint asks. See [Providers](providers.md) for other options.

## Create a config

```sh
jevlint init
```

This asks for a provider and presets, then writes `jevlint.toml` in the repository root. Commit it
so your team shares the same rules. `full`, every audit preset at once, comes first and starts
selected. Pick others instead to ask less per file. `jevlint init --yes` accepts the defaults, and
`--user` writes your personal defaults to `~/.config/jevlint/config.toml` instead. `--preset security,solid` picks
the presets up front, and `jevlint preset default` changes them later.

To try another preset on one run, name it: `jevlint audit security`. See
[Choosing presets](presets.md#choosing-presets).

## Preview, then audit

```sh
jevlint audit --dry-run
```

A dry run lists how many files would be sent and estimates the tokens, with no provider requests.
When that looks right:

```sh
jevlint audit
```

The first run calls the model once per file. Unchanged files then come from the
[cache](caching.md), so later runs are nearly instant and free.

## Read the results

Rows are ordered by [priority](scoring.md#priority), so the top row is the best place to start.
Paths are relative to the repository root, and include a line number when jevlint knows one.

To see everything about one file:

```sh
jevlint explain src/orders/process.ts
```

## Fix something

Copy a prompt for the three highest-priority files and paste it into any coding agent:

```sh
jevlint prompt --top 3 --copy
```

Or let an agent do the work:

```sh
jevlint fix --top 1 --agent claude
```

`fix` asks for confirmation, requires a clean git working tree, and prints the score before and
after. It never commits.

For a faster pass, `quickfix` has the agent only edit files, in a few turns and with no tests, then
shows the diff, re-scores what changed and commits each file, so you can review or revert them one
by one:

```sh
jevlint quickfix --top 3 --agent claude
```

`audit` suggests both next steps under its table. See [Coding agents](agents.md).

## Review a change

To see what a pull request or your latest commits made worse, rather than the state of the whole
repository:

```sh
jevlint pr 42
jevlint commits --count 5
```

`pr` needs the [GitHub CLI](https://cli.github.com). Neither touches your working tree. See the
[CLI reference](cli.md#jevlint-pr-number).

## Try the example

The repository ships a deliberately messy project:

```sh
cd examples/messy-shop
jevlint audit --ast-only
```
