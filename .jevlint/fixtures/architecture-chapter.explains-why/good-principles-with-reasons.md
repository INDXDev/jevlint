Chapter: Design principles
Evidence: AGENTS.md, src/decision/decide.ts:20-60, src/config.ts:17, commit:5f1db8a

### Only `src/decision/` imports the AI SDK

The decision API of the `ai` package is experimental, so a breaking release must touch one folder, not twenty (`AGENTS.md`, "Rules the code depends on"). Every other module asks questions through `decideFile` and `decideState` in `src/decision/decide.ts:178`. The cost is one more hop for code that only wants a single answer, and `src/spec/run.ts` has to re-export usage counting it would otherwise get for free. The rule is checked with no model by the SSOT rule `ai-sdk-in-decision`.

### A repository's config cannot name what runs on your machine

`jevlint.toml` comes from the repository being audited, which may be hostile. Settings that name an endpoint, a command or a local path are listed in `USER_ONLY_KEYS` (`src/config.ts:17`) and are refused there. We gave up letting a team share agent commands in the repository; the one exception, `quickfix.after`, runs only after the user approves it in `src/trust.ts`, which was added in commit 8896cdd after the first version ran repository commands without asking.
