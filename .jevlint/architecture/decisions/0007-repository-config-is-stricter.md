---
id: repository-config-is-stricter
title: A repository's config is stricter than the user's, with one gated exception
date: 2026-11-12
status: accepted
components: [configuration, fixer-commands]
enforced_by: [configuration.user-only-keys, fixer-commands.approved-only]
evidence: [docs/architecture.md:198-199, docs/security.md, src/config.ts:17-19, src/trust.ts:1-5, commit:e5d06f4, commit:78e2f39, commit:8896cdd]
---

Dated from commit 78e2f39, which added the gated exception. The stricter repository schema itself
dates from commit e5d06f4, the initial release.

### Context

Auditing an untrusted repository must not hand it the user's keys or shell.

### Decision

`jevlint.toml` cannot set `provider.base_url`, `agents`, `cache` or `max_rule_matches`
(`src/config.ts:19`). `quickfix.after` names commands but stays allowed, so a team can share its
formatters. jevlint runs them only after the user approves that exact list. The approval
fingerprints the root commits and the files the commands read (commits 78e2f39 and 8896cdd,
`src/trust.ts:1-5`).

### Consequences

Every new setting needs a decision on whether it is user-only. `--yes` never approves fixers, and
tools in `node_modules` are not covered, so this narrows the risk without closing it
(`docs/security.md`).

### Alternatives

Making `quickfix.after` user-only. The comment at `src/config.ts:17-18` gives the reason against
it: teams share it in `jevlint.toml`.
