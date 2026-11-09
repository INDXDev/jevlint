# Troubleshooting

## An agent says `Invalid API key` though you are logged in

An API key in your environment, such as `ANTHROPIC_API_KEY`, takes the place of Claude Code's or
Codex's own login. Retry with `--agent-login`, or set `use_login = true` for the agent. See
[Use your subscription, not an API key](agents.md#use-your-subscription-not-an-api-key).

## "No API key found, running AST-only"

No usable key was found for the configured provider or any [fallback](providers.md#fallback). Run `jevlint auth list`, then `jevlint auth set <provider>`,
or export the variable from [Providers](providers.md) and run `jevlint auth env on`.

## 401 or 403 from the provider

The key is wrong, expired, or lacks access. Some decision APIs are gated by account, so confirm that
your account can use the model. Cloudflare tokens need Workers AI permission.

## 429 Too Many Requests

jevlint retries automatically. If it persists, lower `concurrency` in your config or pass
`--concurrency 2`. Cached results are kept, so running again resumes where you stopped.

## A file has no model score

Look at its warnings with `jevlint explain <file>`. The provider may have refused or failed for that
file, in which case jevlint keeps its AST score. Other files are unaffected.

## "File truncated"

The file is longer than `max_file_chars`, so the model saw only the beginning. AST metrics still
cover the whole file. Raising the limit can exceed your provider's context window.

## A file ranks last with a low score

It has a whole-file [pin](scoring.md#pinning-scores). `jevlint explain <file>` shows the reason, and
`jevlint audit --ignore-pins` shows its real score.

## A file is missing from the report

Check `.gitignore`, `include`, `exclude` and the
[built-in exclusions](configuration.md#files-that-are-always-excluded). Files in `skipped` were found
but could not be scored, usually because no function was found in a language without a grammar and
no model ran.

## A warning about the home directory or the number of files

jevlint warns on stderr, then carries on, when the root is your home directory and no paths were
given, or when more than `warn_file_count` files (default 1,000) are in scope. Press Ctrl-C to stop.
Run it inside a project, or narrow the run with paths, `include` or `exclude`. If the repository
really is that large, raise `warn_file_count`.

## Scores changed but the code did not

The model or preset questions changed, or you changed `[weights]`. Pin a model version such as
`jev-1.14.0` for stable comparisons.

## A score moved after a tiny edit

This is normal for decision models. See [Small changes mean nothing](scoring.md#small-changes-mean-nothing).

## "provider.base_url is only allowed in user config"

Move the setting to `~/.config/jevlint/config.toml`. See
[why](configuration.md#settings-a-repository-cannot-set).

## `jevlint fix` refuses to run

It requires a clean working tree. Commit or stash your changes, or pass `--allow-dirty`. Outside a
terminal, it also needs `--yes`.

## The agent command is not found

Install the agent and check it runs on its own, or change its `command` in your
[user config](agents.md#adding-an-agent).

## "Node.js ... has known security holes"

jevlint refuses Node.js releases without the security fixes it requires, and end-of-life lines.
Upgrade to a version the message names.

## `jevlint pr` fails

- **"jevlint pr needs the GitHub CLI":** install [`gh`](https://cli.github.com) and run `gh auth login`.
- **"gh could not read pull request":** check the number, your sign-in, and that you are in a clone of
  that repository.
- **"Could not find the commits of pull request":** run the `git fetch` the message prints. It needs
  full history.

## "This is a shallow clone"

`jevlint commits` needs full history. Run `git fetch --unshallow`, or set `fetch-depth: 0` in CI.

## The cache bucket stops the run

- **"cache.remote needs AWS_ACCESS_KEY_ID":** export the
  [credentials](caching.md#share-the-cache-through-object-storage), or unset `cache.remote`.
- **"no such bucket":** check `cache.remote` and `cache.endpoint`.
- **"refused the cache read":** check the credentials and `cache.region`, and that they may list, read
  and write the prefix.

## Start from a clean slate

```sh
jevlint cache clear
jevlint config path
```
