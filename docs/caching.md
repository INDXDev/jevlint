# Caching

Model calls cost money and time, so jevlint stores every decision. Unchanged files cost nothing on
later runs. A [semantic rule](presets.md#semantic-rules) is cached per match, so editing one function
re-asks only about the matches inside it.

## Location

The cache lives in `~/.cache/jevlint/`. To move it, set `JEVLINT_CACHE_DIR`, `XDG_CACHE_HOME`, or
`cache.dir` in your user config.

## Share the cache through object storage

Point `cache.remote` at a bucket, and CI runs and teammates reuse each other's paid answers. It works
with anything that speaks the S3 API: AWS S3, Cloudflare R2, Google Cloud Storage (HMAC keys), MinIO,
Backblaze B2 and others.

```toml
# ~/.config/jevlint/config.toml
[cache]
remote = "s3://my-bucket/jevlint"
endpoint = "https://<account>.r2.cloudflarestorage.com"   # leave out for AWS
region = "auto"                                           # default: AWS_REGION, then us-east-1
```

In CI, set `JEVLINT_CACHE_REMOTE`, `JEVLINT_CACHE_ENDPOINT` and `JEVLINT_CACHE_REGION` instead. See
[Continuous integration](ci.md#share-the-cache-through-a-bucket).

The local directory stays in front of the bucket:

- A file's entry is looked up locally first. If it is missing, it is downloaded from the bucket once
  and kept, so only the entries a run needs are fetched, however large the bucket grows.
- A new answer is stored locally and uploaded straight away, so nothing needs syncing afterwards.
  Entries already in your local cache are not uploaded.
- Objects use the local layout, `decisions/ab/<key>.json`, under the prefix.

Credentials come from `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and optionally `AWS_SESSION_TOKEN`,
whichever store you use. jevlint does not read `~/.aws`, so after an AWS login, run:

```sh
eval "$(aws configure export-credentials --format env)"
```

They need to list, read and write the prefix (on AWS: `s3:ListBucket`, `s3:GetObject`,
`s3:PutObject`). Without list permission, AWS answers 403 instead of 404 for an object that does not
exist yet. Credentials that cannot write still work: new answers just stay local.

Missing credentials, a bucket that does not exist or a refused read (such as HTTP 403) stop the run with exit code 2, because every
file would fail the same way. A network failure, a server error or a failed upload is ignored: the
run continues, and each affected file is a miss that pays for its answer again.

`audit --dry-run` reads the bucket to tell what is cached, and keeps what it downloads, so it needs
the credentials too. `--ast-only` never touches the bucket, and `--no-cache` skips it. `cache clear` deletes only the local directory. The bucket keeps
every entry until you remove it, so give it a lifecycle rule that expires old objects.

Anyone who can write to the bucket can change the scores of everyone who reads it. See
[Security](security.md#cache-bucket).

## What invalidates an entry

A decision is reused only if all of these match:

- The content sent for the file
- The provider, model and custom endpoint (`base_url`)
- The text and type of every active question

Changing a file, a model or a preset's questions triggers a new request for the affected files.
Adding a `jevlint-score` comment does not, because those lines are removed before sending.
Changing `[weights]`, `[scoring]` or `[priority]` does not, because those apply afterwards. AST
analysis is fast enough that it always runs fresh.

The cache is shared across repositories, so identical content is scored once, even for identical
files audited at the same moment.

If you use a moving alias such as `jev-latest`, a new model version keeps serving old cached answers
until the file changes. Pin a version, or clear the cache after an upgrade.

An entry that is damaged or the wrong shape counts as a miss and gets replaced. A cache directory
that cannot be written is ignored: answers still reach the report, but each run pays for them again.

## Commands

```sh
jevlint cache info         # location, entries, size, bucket
jevlint cache clear        # delete all local decisions
jevlint audit --no-cache   # bypass for one run
```

## What is stored

Each entry holds question ids, numeric answers and token usage. It contains no source code. The key
is a SHA-256 hash, so file contents cannot be read back from it.
