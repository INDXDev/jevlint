---
title: Glossary
evidence: [src/types.ts:13-182, src/types.ts:533-555, src/types.ts:716-756, src/directives.ts:1-10, src/rules.ts:1, src/config.ts:11-19, src/baseline.ts:1-11, src/fixtures.ts:1, src/architecture/facts.ts:1-4, src/architecture/review.ts:26-31, docs/concepts.md]
---

| Term | Meaning here | In the code |
| --- | --- | --- |
| Audit | Scoring every file and ranking what to refactor first | `audit()` in `src/audit.ts` |
| Preset | A named TOML set of questions, ast-grep patterns and semantic rules. `full` includes every audit preset | `Preset` in `src/types.ts`, `presets/`, `src/presets.ts` |
| Question | One score or boolean question in a preset. Its full id is `<preset>.<id>` | `Question` in `src/types.ts` |
| Decision model | A provider model that answers typed questions about a state instead of generating text | `src/decision/` |
| State | The text a decision is about: a file's code, an outline, or a change's message and diff | `decideState` in `src/decision/decide.ts` |
| Raw answer | A question's answer before scoring, as cached | `RawAnswer` in `src/types.ts` |
| Compliance | An answer mapped to 0 (worst) to 1 (best) | `ModelAnswer.compliance` |
| Score | A file's or repository's health on `scoring.scale`, mixing AST and model halves by `ast_weight` and `model_weight` | `src/scoring.ts` |
| Priority | The refactor-first value: low score weighted by churn and size | `FileReport.priority`, `rank` |
| Churn | Commits that touched a file over `priority.churn_days` | `commitCounts` in `src/git.ts` |
| Finding | A metric over its limit, a pattern match or a semantic rule hit | `AstFinding` |
| Semantic rule | An ast-grep pattern plus one boolean question asked of each match | `[[rules]]`, `src/rules.ts` |
| Pin | A `jevlint-score` comment that fixes a file's or a question's score, with a reason | `Pin`, `src/directives.ts` |
| Baseline | A recorded set of findings and violations, so a gate judges only what is new | `.jevlint/baseline.json`, `src/baseline.ts` |
| Fixture | A good or bad file that proves a question separates them | `.jevlint/fixtures/`, `src/fixtures.ts` |
| Calibration | The recorded answers on fixtures, compared to notice a model moving | `.jevlint/calibration.json` |
| Intent | Judging a change against its message and the base commit's instructions | `--intent`, `src/intent.ts`, `change-intent` preset |
| Quick fix | An edit-only agent run on the worst files, followed by a diff, a re-score and a commit | `jevlint quickfix`, `src/agent.ts` |
| Fixer | A `quickfix.after` command run on the files an agent changed | `src/fixers.ts` |
| Trust | The user's approval of a repository's fixers, by fingerprint | `src/trust.ts`, `jevlint trust` |
| User-only key | A setting a repository's `jevlint.toml` may not set | `USER_ONLY_KEYS` in `src/config.ts` |
| Spec | The checklist SSOT in `.jevlint/spec/`: a project checklist and features | `Spec` in `src/types.ts`, `src/spec/` |
| Drift | Where the code or documents no longer match the spec or SSOT | `driftSpec`, `driftArchitecture` |
| SSOT | The architecture single source of truth in `.jevlint/architecture/` | `ArchitectureSsot`, `src/architecture/load.ts` |
| Facts | What static analysis tells about a repository with no network: imports, candidates, layers, flows | `ArchitectureFacts`, `src/architecture/facts.ts` |
| Component candidate | A group of files the facts propose as one component | `ComponentCandidate` |
| Violation | Code that breaks an SSOT rule, with a file and line | `ArchitectureViolation` |
| Target status | A component marked as an intended shape. Its violations are known debt | `status: target` |
| Perspective | The kind of unit an architecture review scores: codebase, directory, class, component or design | `Perspective`, `src/architecture/review.ts` |
| Outline | A unit's names, sizes and dependencies, sent instead of code | `ModuleOutline` in `src/architecture/extract.ts` |
| Agent | A coding agent CLI such as `claude` or `codex`, configured in `agents` | `src/agent.ts` |
