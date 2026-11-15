---
id: cache-raw-answers
title: Cache raw answers, score afterwards
date: 2026-11-05
status: accepted
components: [decision, decision-cache, scoring]
enforced_by: [decision.cache-key, scoring.pure]
evidence: [docs/architecture.md:187, src/decision/decide.ts:177-183, commit:e5d06f4]
---

Dated from commit e5d06f4, the initial release, whose `docs/architecture.md` first records it.

### Context

Model calls are slow and paid, and weights and thresholds get tuned often.

### Decision

The cache key is the provider, model, endpoint, questions and content. The value is the raw
answers. `scoring.ts` runs after every lookup (`docs/architecture.md:187`).

### Consequences

Tuning weights is free, and pins, rule thresholds and spec thresholds all apply after the cache.
Every caller has to go through `decideFile`/`decideState` to get this.

### Alternatives

Caching scores, which would re-ask the model whenever a weight changed.
