# Tenant-Scoped Post-Auth Rate Limiting (#195)

> Close the rate-limit-evasion gap: bucket authenticated traffic on the verified tenant, not an unverified JWT claim.

status: implemented
created: 2026-07-31
updated: 2026-07-31

---

## §G Goal

- A client cannot evade per-tenant rate limiting by forging/varying an unverified JWT claim.
- The pre-auth IP-based flood guard stays cheap and unauthenticated-request-friendly.
- One authenticated tenant (any mix of JWT + API-key traffic) shares one real, unforgeable quota.

## §C Constraints

| constraint   | value                                                                                                                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack        | Hono middleware, ioredis sliding-window sorted-set (existing pattern in `apps/api/src/middleware/rate-limit.ts`)                                                                                                       |
| auth         | change lands inside `@platform/auth`'s `requireAuth()` — both JWT and API-key paths                                                                                                                                    |
| out of scope | per-user-within-tenant sub-limits; per-route-class limits inside the new post-auth stage (single uniform tenant limit for v1); rewriting the pre-auth stage's IP-detection logic (`x-forwarded-for`/`x-real-ip` trust) |
| perf         | one extra Redis round-trip per authenticated request (pipelined, same cost shape as the existing pre-auth check)                                                                                                       |
| existing doc | `security.md`: "100 req/min per tenant for standard endpoints, 10 req/min for auth and webhook endpoints" — used to size defaults below                                                                                |

## §I Interfaces

**New shared helper**, moved from `apps/api/src/middleware/rate-limit.ts` into `@platform/redis` (already a dependency of both `apps/api` and `packages/auth`):

```ts
// packages/redis/src/rate-limit.ts
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number; resetAt: number }>;
```

Identical sliding-window sorted-set algorithm the pre-auth stage already uses — no behavior change, just relocated so both stages share one implementation instead of duplicating it.

**New config** (`@platform/config`):

```ts
RATE_LIMIT_TENANT_PER_MIN: z.coerce.number().int().positive().default(600);
```

> Updated 2026-08-11: default raised from 100 to 600. 100/min shared across
> every concurrently active user in a tenant collapsed under completely
> normal multi-user interactive browsing (a single ticket detail page load
> alone fans out to ~8-10 parallel requests) — see security.md.
>
> PR #374/#375/#376/#377 review (M2, 2026-08-12): 600/min is sized for the
> pilot's current headcount (a handful of concurrently active users per
> tenant), not headroom against user-count growth — it's still one flat
> quota shared across every user in the tenant, so the same collapse this
> fix addresses recurs at a somewhat higher concurrent-user count or a
> heavier page (more parallel fan-out per load). Per-user sub-limits or
> plan-tier-scaled limits (see the `RATE_LIMIT_TENANT_PER_MIN`-is-flat note
> in §T's open item below) are the next lever if the pilot outgrows this —
> deliberately not built now, since there's no pilot-tenant headcount data
> yet to size them against. Re-evaluate when a tenant's real concurrent
> active-user count approaches ~15-20 (600/min ÷ ~30-40 req/min per active
> user doing normal interactive browsing) rather than waiting for another
> collapse-under-normal-use incident to surface it.

**`requireAuth()` behavior change** — after `c.set("auth", auth)` on both the JWT path and the API-key path, before calling `next()`:

```
key = `rl:tenant:${auth.tenantId}`
{ allowed, remaining, resetAt } = checkRateLimit(key, env.RATE_LIMIT_TENANT_PER_MIN, 60)
if (!allowed) return 429 { error: "RATE_LIMITED", message: "Too many requests" }
```

Sets the same `x-ratelimit-{limit,remaining,reset}` response headers the pre-auth stage already sets, for consistency.

**`apps/api/src/middleware/rate-limit.ts` behavior change** — `rateLimitKey()` drops the JWT-decode branch entirely:

```ts
function rateLimitKey(c): string {
  return (
    c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown"
  );
}
```

This is the actual fix for #195: bucketing pre-auth never again depends on a claim nobody has verified yet.

## §R Requirements

R1: Pre-auth rate limiting keys strictly on client IP, never on JWT contents.
✓ `rateLimitKey()` has no branch that reads `Authorization` header contents
✓ Two requests with different forged `org`/`sub` claims but the same source IP share one bucket

R2: Every request that passes `requireAuth()` is charged against a real, verified-tenant quota.
✓ A request whose JWT verifies to tenant A and a request whose JWT verifies to tenant B (even from the same IP) get independent buckets
✓ A request with a forged (unverified) claim cannot get its own bucket — only the post-verification `auth.tenantId` is ever used as a key
✓ Exceeding `RATE_LIMIT_TENANT_PER_MIN` within a rolling 60s window returns 429 with the standard `RATE_LIMITED` error body

R3: API-key-authenticated and JWT-authenticated requests from the same tenant share the same quota.
✓ A tenant using both an API key and interactive JWT sessions concurrently is capped by one combined per-tenant counter, not two independent ones

R4: The two rate-limit stages are independently testable and independently failing-open-safe.
✓ If Redis is unreachable, `checkRateLimit` fails open (existing behavior — logged, not blocking), preserved for both stages
✓ Isolation/unit tests cover: pre-auth IP-only keying, post-auth tenant keying, forged-claim evasion attempt is blocked by stage 2 even if it slips stage 1

## §V Invariants

- Rate-limit bucketing NEVER keys on JWT/token content that hasn't passed signature verification. (This is the root-cause invariant #195 violated — promote here so it can't regress silently.)
- Every rate-limit check must fail open within a bounded, short timeout on Redis unavailability —
  not just "eventually reject." ioredis queues commands while disconnected by default rather than
  rejecting fast, so an unbounded await on a rate-limit check can hang a request indefinitely
  during a Redis outage. Verified with a real hung-pipeline test that asserts elapsed time, not
  just that the promise eventually resolves.

## §T Tasks

| id  | task                                                                                                                       | phase | status                        | depends |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------- | ------- |
| T1  | Move `checkRateLimit` sliding-window helper into `packages/redis/src/rate-limit.ts`, export it                             | 1     | done                          | —       |
| T2  | Update `apps/api/src/middleware/rate-limit.ts` to import the shared helper; simplify `rateLimitKey()` to IP-only           | 1     | done                          | T1      |
| T3  | Add `RATE_LIMIT_TENANT_PER_MIN` to `@platform/config`                                                                      | 1     | done                          | —       |
| T4  | Add post-auth tenant-scoped check inside `requireAuth()` (both JWT and API-key paths) in `packages/auth/src/middleware.ts` | 2     | done                          | T1, T3  |
| T5  | Unit tests: pre-auth IP-only keying (rate-limit.test.ts, new/updated)                                                      | 1     | done                          | T2      |
| T6  | Unit tests: post-auth tenant keying + forged-claim-still-blocked scenario (middleware.test.ts, updated)                    | 2     | done                          | T4      |
| T7  | Isolation test: two tenants' authenticated traffic still authenticate correctly through the new stage                      | 2     | done (scope revised — see §B) | T4      |
| T8  | Bound `checkRateLimit` with a real timeout so "fails open" holds even when Redis is unreachable (not just erroring fast)   | 1     | done                          | T1      |

phase gate: all unit + integration tests pass before advancing to next phase

**Open item, not guessed:** should the post-auth limit be uniform (100/min flat, this spec's default) or route-class-aware (distinguishing "auth-sensitive" endpoints the way the pre-auth stage already does via `isAuthRoute`)? `security.md` documents both a 100/min standard default AND a 10/min auth/webhook figure, but `requireAuth()` has no path-classification today and every `/api-keys/*` route (the closest thing to "auth-sensitive" that's actually behind `requireAuth()`) already gets the pre-auth stage's tighter 10/min IP-based limit before it ever reaches this new post-auth stage. Proposing: v1 ships one flat tenant-wide limit (100/min); route-class-aware post-auth limits are a separate follow-up if the flat limit proves too coarse in practice. Flag if you want route-awareness in v1 instead.

## §B Bugs / Backprop Log

| id  | what failed                                                                                                                          | root cause                                                                                                                                                                                                                                                                                                                                                                          | promoted to §V?                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —   | (original #195 finding) rate limiter bucketed on unverified JWT `org`/`sub` claim                                                    | pre-auth middleware ran before `requireAuth()` set verified `auth`, so its "prefer verified auth" branch was permanently dead code, and the fallback trusted an unverified claim                                                                                                                                                                                                    | yes — see §V                                                                                                                                             |
| B1  | T7's isolation test hung/timed out (5s) against real, unreachable Redis instead of failing open                                      | `getRedis()` uses `lazyConnect: false` + ioredis's default `enableOfflineQueue: true` — a command issued while disconnected queues and waits through the retry backoff rather than rejecting; the spec's original assumption that this "already fails open like the pre-auth stage" was never actually verified against the pre-auth stage's real code, which also had no try/catch | yes — see §V; also added T8                                                                                                                              |
| B2  | After T8's fix, `middleware.test.ts`'s "fails open when checkRateLimit throws" test started failing (500 instead of 200)             | Removed `enforceTenantRateLimit`'s try/catch on the assumption `checkRateLimit` can no longer throw — true for the real implementation, but the unit test's mock can still be made to reject, and a caller this broadly used (every authenticated request) shouldn't rely on a callee's internal contract alone                                                                     | no — addressed by keeping a second, independent try/catch in the caller rather than promoting to a new invariant (already covered by the §V entry above) |
| —   | T7 scope revised from "prove independent bucketing against real Redis" to "prove tenant isolation still holds through the new stage" | this repo's dev/CI Redis container has no host port mapping by design (docker-compose.yml) — a host-run isolation suite can never reach it, so the sliding-window bucketing itself is unit-tested (mocked pipeline) rather than isolation-tested                                                                                                                                    | n/a                                                                                                                                                      |

---

_spec is source of truth — update as decisions are made_
