# Configuration

jevlint works with no config. Everything below is optional.

## Where config lives

| Layer | Location | Use it for |
| --- | --- | --- |
| Defaults | Built in | |
| User | `~/.config/jevlint/config.toml` | Your provider, agents, personal defaults |
| Repository | `jevlint.toml` | Rules shared with your team |
| Flags | Command line | One-off changes |

Later layers win. Tables merge key by key, and arrays are replaced rather than combined.
`XDG_CONFIG_HOME` moves the user directory.

jevlint finds the repository config by walking up from the current directory. The directory holding
`jevlint.toml` is the root. If there is none, the root is the git root, then the current directory.

Run `jevlint config show` to see the result, and `jevlint config path` to see which files applied.

## Full example

Every value below is the default unless a comment says otherwise.

```toml
presets = ["readable-code"]
include = ["**/*"]
exclude = []            # added to .gitignore and the built-in exclusions
concurrency = 8
max_file_chars = 80000  # longer files are truncated before sending
warn_file_count = 1000  # warn when more files than this are in scope
max_rule_matches = 20   # user config only: semantic rule matches judged per rule per file

[provider]
name = "typesafe"
model = "jev-latest"    # default depends on the provider
# account_id = "..."    # Cloudflare only
# base_url = "..."      # user config only, set with the provider's name

[scoring]
scale = 100
precision = 0           # decimal places shown, 0 to 100
ast_weight = 0.4        # at least one of the two weights must be above 0
model_weight = 0.6
fail_under = 0          # 0 disables the check

[priority]
churn = 0.5
size = 0.25
churn_days = 180

[ast]
max_cognitive_complexity = 15
max_nesting = 4
max_function_lines = 60
max_params = 4
max_file_lines = 400

[weights]               # empty by default
"readable-code.naming" = 3
"readable-code.comments" = 0   # 0 turns a question off

[[patterns]]            # none by default
id = "no-console"
language = "typescript"
pattern = "console.log($$$)"
message = "Use the logger instead of console.log"

[[rules]]               # none by default
id = "catch-hides-failure"
language = "typescript"
pattern = "try { $$$ } catch ($E) { $$$ }"
question = "Does this catch block swallow a failure the caller needed to know about?"
message = "This catch hides a failure"
fix = "Rethrow it, or return an error the caller must handle."
threshold = 0.8         # report at or above this probability

[agents.claude]         # user config only
command = ["claude", "-p", "--permission-mode", "acceptEdits"]

[agents.codex]          # user config only
command = ["codex", "exec", "--sandbox", "workspace-write", "-"]

[cache]                 # user config only
dir = "~/.cache/jevlint"
# remote = "s3://my-bucket/jevlint"     # share the cache through object storage
# endpoint = "https://storage.example"  # for a store other than AWS
# region = "us-east-1"
```

## Top-level keys

| Key | Type | Description |
| --- | --- | --- |
| `presets` | string[] | Presets to apply. `jevlint preset default` sets it for you, and `jevlint audit <preset>` or `--preset` overrides it for one run |
| `include` | string[] | Globs to audit, relative to the root |
| `exclude` | string[] | Globs to skip |
| `concurrency` | integer | Maximum parallel provider requests |
| `max_file_chars` | integer | Characters sent per file |
| `warn_file_count` | integer | Warn on stderr when more files than this are in scope |
| `max_rule_matches` | integer | [Semantic rule](presets.md#semantic-rules) matches judged per rule per file. The rest are skipped with a warning |

Decision models have context limits. Jev allows 32k tokens per question by default, so the default
of `max_file_chars` leaves headroom. Truncated files get a warning in the report.

## Architecture limits

Used by [`jevlint architecture`](architecture-review.md). These are the defaults:

```toml
[architecture]
max_fan_out = 12            # internal imports in one file
max_hub_links = 5           # the lower of a file's imports and its users
max_directory_files = 20    # source files directly in a directory
max_class_methods = 20
max_class_lines = 300
max_inheritance_depth = 3
```

## Files that are always excluded

jevlint reads source code only. A file must have a known source extension, such as `.ts`, `.py`,
`.rb`, `.java`, `.c` or `.sh` (the full list is `SOURCE_EXTENSIONS` in `src/files.ts`). `include`
and path arguments cannot widen this, so docs, data, media, lockfiles and tool dotfiles such as
`.node-version` are never audited, and neither are extensionless files such as `Dockerfile`.

Among source files, and besides `.gitignore` matches, jevlint never reads these:

- Secrets: `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `*credentials*`, `*secret*`.
  These match source files too, so `secrets.py` and `credentials.ts` are never audited. A file with
  such a name may hold real secrets, so jevlint errs on the side of not uploading it.
- Generated: `node_modules`, `dist`, `build`, `vendor`, `target`, `coverage`, `*.min.*`
- [Fixtures](presets.md#testing-a-question), which are bad on purpose: `.jevlint/fixtures/`
- Binary files

## Settings a repository cannot set

These keys work only in your user config. In `jevlint.toml` they are a config error:

| Key | Why |
| --- | --- |
| `provider.base_url` | A cloned repository could send your API key to its own server |
| `agents` | A cloned repository could run arbitrary commands through `fix` |
| `cache` | `cache clear` deletes this directory, and a bucket's answers set your scores |
| `max_rule_matches` | It caps what a repository's [rules](presets.md#semantic-rules) can spend of your money |

API keys never belong in either config file. See [Providers](providers.md#storing-keys).

## Environment variables

| Variable | Description |
| --- | --- |
| `JEVLINT_BASE_URL` | Overrides `provider.base_url` |
| `JEVLINT_CACHE_DIR` | Overrides `cache.dir` |
| `JEVLINT_CACHE_REMOTE` | Overrides `cache.remote` |
| `JEVLINT_CACHE_ENDPOINT` | Overrides `cache.endpoint` |
| `JEVLINT_CACHE_REGION` | Overrides `cache.region`. `AWS_REGION` works too |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | Sign requests to `cache.remote`, on any S3-compatible store |
| `XDG_CONFIG_HOME` | Parent of the user config directory |
| `XDG_CACHE_HOME` | Parent of the default cache directory |
| `DEBUG` | Any value prints the stack trace of an unexpected error |

Provider key variables are listed in [Providers](providers.md).
