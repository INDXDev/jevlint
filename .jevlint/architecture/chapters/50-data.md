---
title: Data and state
evidence: [src/types.ts:94-182, src/types.ts:716-756, src/cache.ts:1-33, src/remote-cache.ts:1-17, src/decision/decide.ts:61-67, src/decision/decide.ts:89-104, src/decision/decide.ts:163-175, src/architecture/collect.ts:25-28, src/config.ts:270-277, src/baseline.ts:10-25, src/trust.ts:1-5, src/review.ts:24-27, docs/security.md, docs/caching.md]
---

The data model follows the principle that scoring runs after the cache. Presets ask questions, the
cache keeps only `RawAnswer`s, and every report type is computed fresh from them on each run.

<!-- jevlint:diagram data-model -->

### What is stored where

| State | Where | Written by | Read by | Lives |
| --- | --- | --- | --- | --- |
| Decision answers | `decisions/<2 chars>/<key>.json` in `cache.dir` (`src/cache.ts:10`) | `decision` (`writeThrough`) | `decision`, `audit --dry-run` | Until `jevlint cache clear` |
| Architecture outlines | The same cache directory, keyed by content hash | `architecture-verbs` (`collect.ts`) | Every architecture verb | Until cleared, or until `OUTLINE_VERSION` changes |
| Cache bucket | `cache.remote` (`s3://…`), user config only | `decision-cache` (SigV4 PUT) | Every machine sharing it | As the bucket's policy says |
| User config, keys, presets, approvals | `~/.config/jevlint/`: `config.toml`, `credentials.toml` (mode 0600), `presets/`, `trusted.json` (`src/config.ts:270-277`) | `init`, `auth`, `preset`, `trust` | `configuration`, `presets`, `fixer-commands` | Until the user changes them |
| Repository config and presets | `jevlint.toml`, `.jevlint/presets/` | People; `init`, `preset add --repo` | `configuration`, `presets` | Committed |
| Baseline | `.jevlint/baseline.json` (`src/baseline.ts:11`) | `jevlint baseline` | `audit --new`, `architecture check --new` | Committed |
| Fixtures and calibration | `.jevlint/fixtures/`, `.jevlint/calibration.json` | People; `jevlint test` writes the record | `preset-fixtures` | Committed |
| Spec and architecture SSOT | `.jevlint/spec/`, `.jevlint/architecture/` | People and coding agents, never jevlint | `ssot-loading` | Committed |
| Change snapshots | A new private temp directory per side | `change-review` | `audit` | Deleted after the review |
| In-flight decisions | A module-level `Map` in `src/decision/decide.ts:164` | `decideState` | Identical files in the same run | One process |

jevlint writes into the repository only what a user asks for: the baseline, the calibration
record, `--html`, `init`'s files, `preset --repo`, and the files an agent edits under `quickfix`.
`show --markdown` and every prompt go to stdout (`docs/security.md`).

### What must stay consistent

- **The decision cache key covers everything that changes an answer:** provider, model id,
  endpoint, the questions as sent, and the content after truncation to `max_file_chars`
  (`src/decision/decide.ts:61-67`). `cacheKey` sorts object keys before hashing
  (`src/cache.ts:30-33`), so equal requests share an entry. A field left out of the key would serve
  one model's answers for another's.
- **A cache entry is trusted only when complete.** An entry is plain JSON on disk, so one missing
  any answer counts as a miss (`src/decision/decide.ts:89-104`). Bucket entries are used as they
  are, so write access to a bucket sets the model half of everyone's scores (`docs/security.md`).
- **Outlines carry a version.** `OUTLINE_VERSION` in `src/architecture/collect.ts:26` must be bumped
  whenever `ModuleOutline` changes shape, or stale entries are read.
- **Pins never reach the model.** `parseDirectives` strips `jevlint-score` comments before the code
  is hashed or sent, so adding a pin neither changes the answer nor invalidates the cache.
- **The SSOT matches its file names.** Each component, flow and view `id` must equal its file
  name, and `compiled_at` must be a commit hash. `drift` and `compile` measure change from it.
- **An approval matches what will run.** `trusted.json` keys each project root to a fingerprint of
  the commands, the root commits and the files those commands read (`src/trust.ts:1-5`). Any change
  asks again, and quickfix checks the fingerprint again before each round of fixers.
- **The baseline is validated before use.** A symlink that leads outside the repository is an
  error (`docs/security.md`). The schema is a list rather than a table keyed by path, so a path
  cannot collide with an object's own keys (`src/baseline.ts:13`).
