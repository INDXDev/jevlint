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
jevlint quickfix --agent claude --yes > quickfix.patch
```

`quickfix` is `fix` made quick. It reuses the audit, so the cache answers it, and sends the same
issues as `prompt`. The instructions are different: edit only, preserve behaviour and public APIs,
run no tests, builds or other commands, do not commit, and finish in one turn or a few at most.
It does not re-score the file. It prints what the agent changed instead:

- The diff goes to stdout, coloured in a terminal, with the words that changed within a line
  highlighted. Redirected, it is a plain patch that `git apply` accepts.
- A summary, one line per file as `git diff --stat` prints it, goes to stderr with the agent's own
  output, so stdout stays a patch.
- `--json` prints each file with its score and diffs instead.

The diff covers the file and any file the agent added or changed that git saw as unchanged before
the run. With `--allow-dirty`, edits to files that already had changes, other than the one being
fixed, are not shown.

It runs each agent's `quickfix_command`, or its `command` when there is none. The built-in ones keep
the run short: Claude Code gets only the file tools and at most 10 turns, and Codex reasons at low
effort.

## Default agents

```toml
[agents.claude]
command = ["claude", "-p", "--permission-mode", "acceptEdits"]
quickfix_command = [
  "claude", "-p", "--permission-mode", "acceptEdits",
  "--tools", "Read,Edit,Write,Glob,Grep", "--max-turns", "10",
]

[agents.codex]
command = ["codex", "exec", "--sandbox", "workspace-write", "-"]
quickfix_command = [
  "codex", "exec", "--sandbox", "workspace-write", "-c", 'model_reasoning_effort="low"', "-",
]
```

If you change an agent's `command`, change its `quickfix_command` too, because each falls back to
the default separately.

## Adding an agent

Any command that reads a prompt from stdin works. Add it to your **user** config:

```toml
# ~/.config/jevlint/config.toml
[agents.my-agent]
command = ["my-agent", "--non-interactive"]
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
