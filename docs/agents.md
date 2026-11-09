# Coding agents

jevlint finds and ranks problems. Coding agents such as Claude Code and Codex fix them.

## Copy and paste

```sh
jevlint prompt --top 3 --copy
```

The prompt names each file with its score, AST findings with line numbers, the weakest principles
with fix guidance, and instructions to preserve behaviour and run the tests. It contains file paths
but not file contents, because the agent reads the code itself.

Files with a whole-file [pin](scoring.md#pinning-scores) are left out, as are pinned questions, so
agents do not chase scores your team has accepted. The prompt also tells agents not to add or change
`jevlint-score` comments.

## Pipe

```sh
jevlint prompt | claude -p
jevlint prompt | codex exec -
```

A piped agent uses its own permission settings, and may stop to ask or refuse to edit.

## `jevlint fix`

```sh
jevlint fix --agent claude
jevlint fix src/orders/process.ts --agent codex
jevlint fix --top 3 --agent claude --yes
```

For each file, `fix`:

1. Checks the git working tree is clean, unless you pass `--allow-dirty`.
2. Shows the plan and asks for confirmation, unless you pass `--yes`. Outside a terminal, `--yes` is
   required.
3. Runs the agent with the prompt on stdin.
4. Re-audits the file and prints the score before and after.

**`fix` lets an agent edit your files.** The default commands allow edits, so review the diff before
you commit. jevlint never commits, pushes, or loops on its own. Stop with `Ctrl-C`, and undo with
git.

Files run one at a time so that agents do not conflict. Stop early if an agent exits with an error.

## `jevlint quickfix`

```sh
jevlint quickfix --agent claude
jevlint quickfix src/orders/process.ts --agent codex
jevlint quickfix --top 5 --agent claude --yes
jevlint quickfix --agent claude --yes > quickfix.patch
```

`quickfix` is `fix` made quick. It reuses the audit, so the cache answers it, and sends the same
issues as `prompt`. The instructions are different: edit only, preserve behaviour and public APIs,
run no tests, builds or other commands, do not commit, and finish in one turn or a few at most.

For each file, in priority order and one at a time, `quickfix`:

1. Runs the agent with the edit-only prompt, labelled `[2/5]` and so on when there are several.
2. Prints what changed. The diff goes to stdout: side by side in a terminal at least 120 columns
   wide, unified and coloured in a narrower one, and a plain patch that `git apply` accepts when
   redirected. Either way the words that changed within a line are highlighted.
3. Re-audits every file it changed, with the same presets, and prints a `git diff --stat` style
   summary with each file's score before and after to stderr, beside the agent's own output.

`--json` prints each file with its scores and diffs instead. `--side-by-side` forces two panels,
even in a pipe, and `--no-side-by-side` forces the unified view.

The diff covers the file, every file the agent added, and every file it edited. A file that already
had changes, from `--allow-dirty` or an earlier file's run, is compared with what it held just before
this run, so each run shows only its own edits.

It runs each agent's `quickfix_command`, or its `command` when there is none. The built-in ones keep
the run short: Claude Code gets only the file tools and at most 10 turns, and Codex reasons at low
effort.

## Use your subscription, not an API key

Claude Code and Codex can run on your Claude or ChatGPT subscription, with no API key. But an API key
in the environment wins over that login, so a stale key makes the run fail even though you are
logged in:

```text
Invalid API key · Fix external API key
Error: Agent exited with code 1 on src/a.ts. ANTHROPIC_API_KEY is set, and claude uses it instead
of its own login. If the key was rejected, retry with --agent-login, ...
```

Pass `--agent-login` to `fix` or `quickfix`, and jevlint leaves the agent's key variables out of the
environment it starts the agent with. Your shell keeps them.

```sh
jevlint quickfix src/a.ts --agent claude --agent-login
```

To make that the default for an agent, set `use_login` in your user config:

```toml
[agents.claude]
use_login = true
```

| Agent | Variables left out | Log in once with |
| --- | --- | --- |
| `claude` | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` | `claude`, then `/login`. With no browser, run `claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN` |
| `codex` | `OPENAI_API_KEY`, `CODEX_API_KEY` | `codex login`, or `codex login --device-auth` with no browser |

Why the key wins:

- **Claude Code** in `-p` mode always uses `ANTHROPIC_API_KEY` when it is present, and
  `ANTHROPIC_AUTH_TOKEN` ranks above it. Only an unset variable falls back to the subscription; an
  empty one is not documented to. See
  [Authentication precedence](https://code.claude.com/docs/en/authentication#authentication-precedence).
  `--bare` never reads the login, so do not add it to a command that should use your subscription.
- **Codex** `exec` reuses the login saved by `codex login`, but `CODEX_API_KEY` replaces it for a
  run. See [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).

Each agent's `key_env` lists the variables to leave out, so an agent you add can use this too.

## Default agents

```toml
[agents.claude]
command = ["claude", "-p", "--permission-mode", "acceptEdits"]
quickfix_command = [
  "claude", "-p", "--permission-mode", "acceptEdits",
  "--tools", "Read,Edit,Write,Glob,Grep", "--max-turns", "10",
]
key_env = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]

[agents.codex]
command = ["codex", "exec", "--sandbox", "workspace-write", "-"]
quickfix_command = [
  "codex", "exec", "--sandbox", "workspace-write", "-c", 'model_reasoning_effort="low"', "-",
]
key_env = ["OPENAI_API_KEY", "CODEX_API_KEY"]
```

If you change an agent's `command`, change its `quickfix_command` too, because each falls back to
the default separately.

## Adding an agent

Any command that reads a prompt from stdin works. Add it to your **user** config:

```toml
# ~/.config/jevlint/config.toml
[agents.my-agent]
command = ["my-agent", "--non-interactive"]
quickfix_command = ["my-agent", "--non-interactive", "--max-steps", "5"]  # optional
key_env = ["MY_AGENT_API_KEY"]  # optional: left out with --agent-login
use_login = false               # optional: true always leaves key_env out
```

```sh
jevlint fix --agent my-agent
```

`agents` is rejected in a repository's `jevlint.toml`, so a cloned project cannot choose what
command runs on your machine.

## Check every edit

`jevlint hook` tells an agent what its last edit made worse, against `HEAD`, while it can still fix
it. It reads the edited path as JSON on stdin and exits 2 with the findings on stderr, which Claude
Code feeds back to the agent. It is AST-only, so it sends nothing and costs nothing. An unrelated edit
passes silently. See [the reference](cli.md#jevlint-hook).

Add this to `.claude/settings.json`, with jevlint installed globally:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "jevlint hook" }]
      }
    ]
  }
}
```

The comparison is with `HEAD`, not with the file before this edit, so the agent hears about a finding
on each edit of that file until it is fixed or committed.

Use `jevlint`, not `npx @indxjp/jevlint`. `npx` prefers a copy in the repository's `node_modules`, so
a hook using it would run code from any repository the agent works in.

## Claude Code plugin

The repository is also a Claude Code plugin. It teaches the agent when to use jevlint, what stays on
your machine and what the scores do not mean, and adds `/jevlint:audit`, `/jevlint:explain` and
`/jevlint:review`.

```text
/plugin marketplace add INDXDev/jevlint
/plugin install jevlint@jevlint
```

The plugin calls `jevlint` from your `PATH`, so run `npm install --global @indxjp/jevlint` first.

It includes the edit hook above, turned off, because a hook that speaks up on every edit should be
your choice. To turn it on, answer yes when the plugin asks about `Check every edit`, or run
`claude plugin configure jevlint`. `claude plugin disable jevlint` turns the whole plugin off.

## A good workflow

```sh
jevlint audit
jevlint fix --agent claude
git diff
pnpm test
git commit -am "refactor: simplify order processing"
```
