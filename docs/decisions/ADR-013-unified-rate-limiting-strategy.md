# ADR-013: Unified Rate-Limiting Strategy

**Status:** Accepted.  
**Date:** 2026-08-24  
**Deciders:** Engineering Lead  
**Related to:** ADR-008 (API-key lifecycle — `scopes_format` discriminator reused below), ADR-012 (third-party API's own 3-tier rate limiting, which this draft generalizes), issue #19 (3D
observability — `tenant_config.plan` billing gate, not built yet — confirmed by grep, no `tenant_config` table exists in `packages/db/src/schema/` today).  
**Supersedes:** —  
**Superseded by:** —

---

## Context

Rate limiting today is a patchwork of point fixes rather than a single designed policy:

- `packages/redis/src/rate-limit.ts` — a sliding-window primitive (Redis sorted set), shared by
  a pre-auth IP-based stage (`apps/api/src/middleware/rate-limit.ts`, default 500 req/60s) and a
  post-auth tenant-scoped stage (`packages/auth/src/middleware.ts`, #195 fixed bucketing on an
  unverified JWT claim instead of the authenticated tenant). It fails open (never throws; a Redis
  outage logs a warning and allows the request) with a 250ms check timeout.
- **The tenant-scoped stage already has a live, configurable default**: `RATE_LIMIT_TENANT_PER_MIN`
  (`packages/config/src/env.ts`), `z.coerce.number().int().positive().default(600)` — raised from
  100 to 600/min per PR #419/#375 after 100/min was found to collapse under two normal concurrent
  users in one tenant, not actual abuse. This is a real, already-shipped lever, not a proposal.
- ADR-012 (third-party ticket-access API) already designed a **3-tier model specifically for
  that one feature**: 20 req/min per (key, person), 200 req/min per key, and a per-tenant
  configurable ceiling — reasoned about carefully, but scoped only to that one API surface.
- **`api_keys.scopes_format`** (`packages/db/src/schema/platform.ts`, ADR-008 Decision #6,
  migration 0055) already discriminates every key as `'role'` (legacy/internal, unchanged scoping)
  or `'action'` (new `entity:<type>:<verb>` shape, ADR-010/012 Tier-1 style) — this is an existing
  column, not something this ADR needs to add, and it's the natural lever for telling internal and
  third-party-style keys apart at rate-limit-tier-assignment time too.
- issue #19 (3D observability/compliance) names a future `tenant_config.plan` field as a billing
  gate rate limits should eventually key off of — **doesn't exist as code yet**, confirmed by
  grepping `packages/db/src/schema/` for `tenant_config`/`tenantConfig` (zero matches).

No document currently answers: what the default limits should be for _interactive_ users vs.
_internal_ API keys vs. third-party keys, and how these compose when a request could match more
than one tier at once.

---

## Decision (proposed)

1. **Adopt ADR-012's 3-tier shape as the platform-wide default for any authenticated API
   traffic**, not just third-party keys: per-(key, person) or per-(user, session), per-key/per-user
   aggregate, and per-tenant aggregate. This avoids re-deriving a new shape per feature the way
   ADR-012 had to, and gives every future API surface (webhooks, connectors, ADR-009/010 work) a
   default answer instead of another one-off design pass.
2. **Keep `packages/redis/src/rate-limit.ts`'s sliding-window primitive and fail-open behavior as
   the one enforcement mechanism** — it's already proven (in production use since #195), and
   introducing a second algorithm (token bucket, fixed window) for some paths and not others would
   just be a second thing to reason about with no demonstrated need.
3. **Precedence when multiple tiers apply: the tightest tier wins**, checked in order narrowest to
   widest (per-key-and-person → per-key → per-tenant), short-circuiting on the first rejection.
   This matches ADR-012's own reasoning (the narrow tier exists specifically so one bad actor on a
   shared key can't starve others; the wide tier exists so many well-behaved actors on one tenant
   can't collectively exceed a platform-wide budget).
4. **Tier assignment reuses `api_keys.scopes_format` as the discriminator — no new column.**
   `scopes_format = 'role'` (today's internal keys) gets the existing flat per-tenant-session
   behavior unchanged; `scopes_format = 'action'` (ADR-012-style third-party keys) gets the full
   3-tier model. This resolves what was originally this draft's OQ-1 without new schema: the exact
   column ADR-008 already added for a different reason (scope-string shape) is sufficient to also
   tell these two populations apart for rate-limiting, since they're the same two populations by
   construction (`'action'`-format keys are exactly the ones ADR-012 designed the 3-tier model for).
5. **The per-tenant aggregate ceiling for the general (non-third-party) case reuses the existing
   `RATE_LIMIT_TENANT_PER_MIN` env default (600/min) — not a new number.** This resolves what was
   originally this draft's OQ-2: there's already a shipped, tuned value for exactly this tier
   (tenant-wide aggregate, interactive + internal-key traffic combined); inventing a second number
   for the "general case" when this one already exists and was already tuned once (100 → 600)
   would just be redundant.
6. **Plan-based ceilings (issue #19) are a placeholder seam, not built now.** The per-tenant tier
   in (1) should read its default from the single `RATE_LIMIT_TENANT_PER_MIN`-style config value,
   in a shape a future `tenant_config.plan` can override per-tenant later — matching how ADR-012
   Decision #8 already left this exact seam open for its own slice. No new work here beyond
   keeping that seam consistent platform-wide.

---

## Consequences

### Positive

- Every future API surface gets a default rate-limiting shape without a fresh design pass.
- One enforcement primitive stays the single thing to reason about for correctness/availability
  (fail-open behavior, Redis-outage blast radius).
- Tier assignment (Decision #4) and the general-case ceiling (Decision #5) both reuse existing,
  already-shipped mechanisms — no new schema, no new tuning exercise.

### Negative and mitigations

- **Internal API keys keep today's coarse per-tenant-only behavior** rather than adopting
  ADR-012's tighter per-(key,person) tier — a deliberate scope cut tied to `scopes_format='role'`,
  not an oversight. Mitigation: revisit only if a concrete incident traces back to an internal
  key's traffic pattern specifically (as opposed to overall tenant traffic, which
  `RATE_LIMIT_TENANT_PER_MIN` already bounds).
- **The tightest-tier-wins precedence adds a small amount of check overhead** (up to 3 Redis round
  trips per request in the worst case, each with its own 250ms fail-open timeout) for
  `'action'`-format keys. Mitigation: the checks are already independently fast in production for
  ADR-012's slice; short-circuiting on first rejection keeps the common (allowed) case cheap, and
  `'role'`-format keys (the majority today) are unaffected — they keep the single existing check.

---

## Deferred Decisions

| Deferred Item                                                                                 | Trigger to Revisit                                | Why Deferred Now                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logging/alerting specifically on rate-limit-exceeded responses (originally this draft's OQ-3) | issue #19 (3D observability) shipping actual code | No admin-alert or metrics-emission infrastructure exists yet anywhere in the codebase to hook into (confirmed by grep — `alert-worker.ts`'s only alert type today is SLA-ticket-specific, not a generic misuse/observability channel) — building one just for this would be disproportionate and would duplicate whatever #19 eventually builds generally. |
| Per-tenant plan-based ceiling override (`tenant_config.plan`)                                 | A pricing/plan model actually gets built          | Confirmed no `tenant_config` table exists yet; Decision #6 leaves the seam, doesn't build the table.                                                                                                                                                                                                                                                       |

---

## Open Questions

None remaining that block acceptance — the three original open questions (internal-key tier,
general-case tenant ceiling, rate-limit-exceeded logging) were resolved above by reusing existing
mechanisms (`scopes_format`, `RATE_LIMIT_TENANT_PER_MIN`) or moved to Deferred Decisions pending a
real prerequisite (#19).

---

## Implementation next steps

1. This draft should be reviewed and formally accepted (moved into
   `docs/decisions/ADR-013-unified-rate-limiting-strategy.md` with `Status: Accepted`) by a human,
   per this repo's own rule that ADR files are human-authored/committed.
2. Wire tier assignment (Decision #4) into whichever middleware/service currently checks
   `api_keys` for a request — likely `packages/auth/src/middleware.ts` alongside the existing
   tenant-scoped check, reading `scopes_format` to pick the tier shape.
3. Confirm `RATE_LIMIT_TENANT_PER_MIN`'s existing 600/min default is still the intended
   general-case ceiling before wiring Decision #5 — it was tuned for interactive-session traffic;
   revisit only if internal-API-key traffic patterns turn out to differ materially once measured.
4. Add isolation-test coverage for the tier-selection logic (per this repo's
   `testing-conventions.md` mandate for new enforcement paths).
