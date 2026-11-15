---
id: ai-sdk-in-decision
title: The AI SDK is the provider layer, kept in one folder
date: 2026-11-05
status: accepted
components: [decision]
enforced_by: [ai-sdk-only-in-decision]
evidence: [docs/architecture.md:161-166, src/decision/providers.ts:9, src/decision/providers.ts:32-40, src/decision/decide.ts:12-18, commit:e5d06f4, commit:cd3216c]
---

Dated from commit e5d06f4, the initial release, whose `docs/architecture.md` first records it.

### Context

jevlint asks typed questions (score, boolean, choice) of several providers: TypeSafe, OpenAI, the
Vercel gateway, Cloudflare, Microsoft and generic endpoints.

### Decision

Use the AI SDK's `experimental_decide`, which already handles the protocol, retries and validation.
Cloudflare, Microsoft and generic endpoints reuse the TypeSafe provider with another base URL.
Cloudflare's response envelope is unwrapped by a `fetch` shim (`src/decision/providers.ts:32-40`).
All of it stays in `src/decision/` (`docs/architecture.md:161-164`).

### Consequences

A breaking change in the experimental API touches one folder. Provider limits leak upwards only as
data: Cloudflare's 64-question cap is handled by splitting requests (`src/decision/decide.ts:15`,
commit cd3216c).

### Alternatives

Writing a client per provider. The docs reject it implicitly ("already handles the protocol,
retries and validation"); no further comparison is recorded.
