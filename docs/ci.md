# Continuous integration

## Gate on AST metrics

This needs no secrets and sends nothing to a provider, so it is safe for pull requests from forks.

```yaml
name: jevlint
on: pull_request
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: npm install --global @indxjp/jevlint
      - run: jevlint audit --ast-only --fail-under 60
```

## Gate with a model

```yaml
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }   # full history for churn ranking
      - uses: actions/cache@v4
        with:
          path: ~/.cache/jevlint
          key: jevlint-${{ github.sha }}
          restore-keys: jevlint-
      - run: npm install --global @indxjp/jevlint
      - run: jevlint auth env on   # CI cannot answer the first-run question
      - run: jevlint audit --fail-under 60
        env:
          TYPESAFE_AI_API_KEY: ${{ secrets.TYPESAFE_AI_API_KEY }}
```

GitHub does not expose secrets to pull requests from forks, so with no key the audit runs AST-only.
Those scores differ from a model-backed run. Use the AST-only gate if you accept outside
contributions.

Pin a model version in `jevlint.toml` so that a new release does not move your threshold.

## Share the cache through a bucket

`actions/cache` is per repository and per platform. A [bucket](caching.md#share-the-cache-through-object-storage)
serves every job, runner and teammate, on any CI system. Replace the `actions/cache` step with these
variables:

```yaml
      - run: jevlint audit --fail-under 60
        env:
          TYPESAFE_AI_API_KEY: ${{ secrets.TYPESAFE_AI_API_KEY }}
          JEVLINT_CACHE_REMOTE: s3://my-bucket/jevlint
          JEVLINT_CACHE_ENDPOINT: https://<account>.r2.cloudflarestorage.com   # not for AWS
          JEVLINT_CACHE_REGION: auto
          AWS_ACCESS_KEY_ID: ${{ secrets.CACHE_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.CACHE_SECRET_ACCESS_KEY }}
```

`aws-actions/configure-aws-credentials` also works, because it exports the same variables. Forks get
no secrets, so set `JEVLINT_CACHE_REMOTE` from a secret too. With a remote but no credentials, the run
stops with exit code 2.

## Review what a pull request changes

An audit scores the whole repository. `jevlint pr` shows only what this pull request made worse, here
in the run's summary page. Check out the base commit, so that your own config judges the change
rather than the one in the pull request.

```yaml
name: jevlint review
on: pull_request
permissions: { contents: read, pull-requests: read }
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # the merge base needs history
          ref: ${{ github.event.pull_request.base.sha }}
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: npm install --global @indxjp/jevlint
      - run: jevlint pr ${{ github.event.pull_request.number }} --ast-only >> "$GITHUB_STEP_SUMMARY"
        env:
          GH_TOKEN: ${{ github.token }}
```

`--ast-only` needs no secrets, so this is safe for pull requests from forks. The step only reports,
and a low score does not fail it. To gate, use `jevlint audit` as above.

[`--intent`](cli.md#judging-a-change-with---intent) replaces `--ast-only` here to judge the pull
request against its description and your `AGENTS.md`. It needs a provider key, so keep it away from
pull requests from forks, and it reports without failing the step.

## Gate only on new problems

On a legacy codebase, a score gate either fails on day one or sits too low to catch anything. Record
what is there once, and commit it:

```sh
jevlint baseline --ast-only
git add .jevlint/baseline.json
```

Then fail the build only on what is new or worse:

```yaml
      - run: jevlint audit --new --ast-only --format github
```

Create the baseline in the same mode as the gate: an AST-only baseline holds no answers, so a model
gate would count every weak answer as new. See [`jevlint baseline`](cli.md#jevlint-baseline-paths).

A pull request can edit `.jevlint/baseline.json` to hide its own findings, so review changes to that
file, or restore it from your base branch before the gate, which needs `fetch-depth: 0`:

```yaml
      - run: git checkout ${{ github.event.pull_request.base.sha }} -- .jevlint/baseline.json
```

## Annotate a pull request

`--format github` prints workflow commands, which GitHub shows as annotations on the changed lines.
Run the step from the top of the repository, and add it to any job above:

```yaml
      - run: jevlint audit --ast-only --format github
```

`jevlint pr` takes the same flag, and annotates only what the pull request made worse.

## Show findings in code scanning

`--format sarif` writes a log that GitHub code scanning, and most other tools, can read:

```yaml
    permissions: { contents: read, security-events: write }
    steps:
      # ...
      - run: jevlint audit --ast-only --format sarif > jevlint.sarif
      - uses: github/codeql-action/upload-sarif@v3
        with: { sarif_file: jevlint.sarif }
```

## Check commits before they are made

```sh
npm install --global @indxjp/jevlint
jevlint init --pre-commit
```

This writes a git pre-commit hook that runs `jevlint hook --staged`, which stops a commit if the
staged change made anything worse than `HEAD`. It is AST-only, so it needs no key and sends nothing.
`git commit --no-verify` skips it once.

The hook runs `jevlint` from your `PATH`. Without it, every commit fails until you install it or
remove the hook. An existing hook stays unless you pass `--force`. jevlint refuses a `core.hooksPath`
that leads out of the repository. If you use a hook manager, add `jevlint hook --staged` to it
instead.

## Notice when a model moves

Once you have [recorded your fixtures](presets.md#testing-a-question), a scheduled job tells you when a
model update changes what your questions say. Exit code 1 fails the job. It runs on your own branch and
no outside code, so it can hold a key.

```yaml
name: jevlint drift
on:
  schedule:
    - cron: '0 6 * * 1'
permissions: { contents: read }
jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: npm install --global @indxjp/jevlint
      - run: jevlint auth env on
      - run: jevlint test --drift
        env:
          TYPESAFE_AI_API_KEY: ${{ secrets.TYPESAFE_AI_API_KEY }}
```

Every fixture is asked afresh on each run, so the cost grows with the number of fixtures.

## Pins and thresholds

[`jevlint-score` comments](scoring.md#pinning-scores) count towards the repository score, so anyone
who can edit a file can raise it. Review them like any other suppression. To gate on real scores,
add `--ignore-pins`. The same goes for `audit --new`, which treats a pinned file as settled.

A pull request can also change `jevlint.toml`, including `scoring.scale` and `exclude`, and so move
its own gate. Review changes to that file, or run the gate with a config from your base branch.

Do not use `npx @indxjp/jevlint` on untrusted branches: it prefers a copy in `node_modules` committed
to the tree. Install jevlint first, as above.

## Choosing a threshold

Run an audit on your main branch and set `fail_under` a little below the result. Raise it as the code
improves.

## Using the JSON report

```sh
jevlint audit --json > jevlint-report.json
jq -r '.files[:5][] | "\(.score) \(.path)"' jevlint-report.json
```

See [JSON output](json-output.md).
