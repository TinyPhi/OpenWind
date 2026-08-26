# Third-Party API Phase G — Hardening

> Closing gate before any real external party gets a key: rate limiting (per-key/per-tenant),
> idempotency, TLS enforcement, PII redaction on reads, and access-log retention/anonymization.

status: implemented
created: 2026-08-26
updated: 2026-08-26 (Phase 3 implementation done: T8-T12 marked done — access-log-retention
sweep + admin_audit_log_daily_rollup table, tenant-purge anonymizes admin_audit_log and
deletes idempotency_keys, Phase F residual-risk disclosure confirmed accurate, final
cross-phase /security-review run with a "not ready yet" verdict resolved in-session — see B2
and the R11 resolution note below. All of Phase G (T1-T12) is now done; Phase 2 implementation
done before that: T6-T7 marked done — idempotency_keys table,
RFC 8785 content-hash via the `canonicalize` package, 30s Redis in-flight lock + 24h result
cache, wired into create/comment/sub-ticket/transition third-party routes; Phase 1
implementation done before that: T1-T5 all marked done, T2's §I interface sketch corrected to
reflect the actual implementation — tenants.config JSONB key, not a new column; spec-review
pass before that: quantified R1/R2's rate-limit numbers and cache-staleness bound, added R10
for idempotency-cache tenant-purge coverage, renumbered R10-R12 to R11-R13, added 2
invariants, added T10 and clarified T2/T3's scope)

---

## §G Goal

Every checklist item in the design doc's "Phase G — Hardening" section is closed, verified by
tests, and passes a final end-to-end `/security-review` — the actual gate before Phase 4 (real
external test) can begin. Nothing here is aspirational-only (ADR-013 exists as a design doc but
isn't wired into any code yet — this phase is what wires it).

## §C Constraints

| constraint   | value                                                                                                                                                                                                                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack        | Redis (`@platform/redis`, sliding-window pattern already established by `checkRateLimit`) for rate limits + idempotency locks/cache; Postgres for per-tenant rate-limit config and idempotency result cache; existing `redactMetadata`/`buildSensitivityMap` (`@platform/workflow-engine`) for PII redaction, not a new redactor |
| auth         | No new auth surface — this phase hardens existing third-party API-key auth, doesn't change it                                                                                                                                                                                                                                    |
| already done | API versioning (`/api/v1/`, Phase B) — no work. Tenant-purge already hard-deletes a purged tenant's `api_keys` rows (`apps/worker/src/tenant-purge.ts:218`) — no work, but §R7's anonymization requirement is a NEW addition to the same function, not a duplicate of this.                                                      |
| out of scope | Rebuilding `checkRateLimit`'s sliding-window primitive (reused, not replaced); a pricing/plan-tier model for the per-tenant rate ceiling (explicitly a forward seam per ADR-013, not built now); re-litigating Phase F's volume-spike alert design (only documenting its known residual risk here)                               |
| depends on   | Phases A–E merged into `main` (true as of 2026-08-26). Phase F (access logs + misuse alerts) is still open as PR #489 — this spec's own tasks don't touch Phase F's code, so it doesn't block starting Phase G, but final §R13's cross-phase `/security-review` should re-run once F merges too                                  |

## §I Interfaces

```
-- Rate limiting (extends packages/redis/src/rate-limit.ts's checkRateLimit, 3 tiers) --
checkRateLimit(redis, "key-person:<apiKeyId>:<personId>", 20, 60)   -- per (key,person)
checkRateLimit(redis, "key:<apiKeyId>", 200, 60)                     -- per key, aggregate
checkRateLimit(redis, "tenant:<tenantId>", <configurable>, 60)       -- per tenant, admin-editable

-- Per-tenant rate ceiling (implemented: tenants.config JSONB key, not a new column —
-- same storage convention as notifications' per-user preferences; avoids a migration
-- for a single optional override value)
tenants.config.rate_limit_per_min: number, optional (absent = platform default, env RATE_LIMIT_TENANT_PER_MIN)
read path cached in-process, 5s TTL (packages/auth/src/tenant-rate-limit.ts) -- satisfies R2's "within 5s"

PATCH /admin/tenants/:id/rate-limit  { ratePerMin: number | null }   -- admin-editable, superadmin only

-- Idempotency (implemented: packages/db/migrations/0082_idempotency_keys.sql)
idempotency_keys: (id, tenant_id, api_key_id, acting_person_id, idempotency_key,
                    content_hash, response_status, response_body, created_at, expires_at)
  unique (tenant_id, api_key_id, acting_person_id, idempotency_key)
-- content_hash: RFC 8785 JCS via the `canonicalize` npm package (reference
-- implementation), sha256 hex -- apps/api/src/lib/idempotency.ts

-- request header: Idempotency-Key: <caller-supplied string>
-- 30s in-flight lock: Redis key `idempotency-lock:<tenantId>:<apiKeyId>:<personId>:<key>`, NX + 30s TTL
-- 24h result cache: idempotency_keys row, expires_at = created_at + 24h

-- PII redaction on reads
GET /api/v1/tickets/:id        -- fields now pass through redactMetadata before response
GET /api/v1/workflows          -- same, for any field beyond the current static allowlist

-- Access-log retention
apps/worker: new scheduled job (mirrors sla-scheduler.ts's pattern) sweeping admin_audit_log
  rows older than 90 days; aggregate rollup table (new, e.g. admin_audit_log_daily_rollup)
tenant-purge.ts: REPLACES its current hard-keep-forever comment with an anonymization UPDATE
  on admin_audit_log for the purged tenant (not a delete)
```

## §R Requirements

R1: A third-party request is rejected once ANY of three independent rate-limit tiers is
exceeded — per (api_key, acting_person) at 20/min, per api_key aggregate at 200/min, or per
tenant aggregate at the tenant's configured ceiling (default: the platform-wide
`RATE_LIMIT_TENANT_PER_MIN`, currently 600/min) — whichever is hit first.
✓ A key operating as many distinct, individually-valid people (each under the 20/min
per-key-person limit) is still rejected once the key's own aggregate crosses 200/min.
✓ A tenant with multiple keys, each individually under its own limits, is still rejected once
combined tenant traffic crosses the tenant's configured ceiling (600/min if no override is set).
✓ Below all three thresholds, a request succeeds normally (no false-positive rejection).

R2: The per-tenant rate-limit ceiling is admin-editable and takes effect within 5 seconds of
the PATCH, without a code change or restart.
✓ An admin PATCHes a tenant's rate limit; a request against that tenant sent 5s or more after
the PATCH is evaluated against the new value — no unbounded/undocumented cache staleness window.
✓ A tenant with no explicit override falls back to the platform-wide default
(`RATE_LIMIT_TENANT_PER_MIN`, currently 600/min), unchanged from today's behavior.

R3: A repeated request carrying the same `Idempotency-Key` header, scoped to
`(api_key_id, tenant_id, acting_person_id)`, returns the original cached result instead of
re-executing, as long as the request content is identical and the key is within its 24h TTL.
✓ Two different applications (or the same application acting as two different people) using
the identical idempotency-key string never see each other's cached result.
✓ A retry inside the 24h TTL window returns the cached result, byte-identical response.
✓ A retry after the TTL performs the action again (documented behavior, not a bug).

R4: An idempotency key reused with different request content is rejected as a conflict, not
silently replayed or re-executed.
✓ Same key + same canonicalized content (RFC 8785 JSON Canonicalization Scheme — sorted keys,
consistent encoding, including any referenced attachment IDs) → cached result returned.
✓ Same key + different content → `409` with a clear "idempotency key already used for a
different request" error, and the second request's action is NOT performed.
✓ A retry whose HTTP client serializes identical JSON with different key ordering is
recognized as the SAME request (not falsely rejected as a conflict).
✓ A request whose only difference is a referenced attachment ID is correctly treated as
DIFFERENT content.

R5: Two requests carrying the same idempotency key arriving at effectively the same time never
both execute the underlying action.
✓ Fire two identical requests with the same idempotency key concurrently — exactly one
succeeds and creates the resource; the other gets `409` with a short `Retry-After`, not both
succeeding and not the second one silently waiting for the first's result.
✓ The in-flight lock is time-bounded (30s, config-driven) — a crashed/hung first request does
not permanently block retries with that key.

R6: JWT-authenticated third-party requests are rejected if the token's `iat` is older than a
configurable max-age (default 15 minutes), independent of Zitadel's own token expiry.
✓ A JWT with a valid signature and `aud` but an `iat` older than the configured max-age is
rejected (401), distinct from an actually-expired-per-`exp` token.
✓ The max-age value is read from config (`@platform/config`), not hardcoded, and a startup
check warns if it's ever configured above 30 minutes.

R7: Every third-party read response (ticket detail, workflow list) has PII/financial field
values redacted according to the entity type's own field-sensitivity map, identically to how
the connector-outbound-worker already redacts outbound payloads.
✓ A ticket with a field marked `sensitivity: pii` or `sensitivity: financial` returns a
redacted placeholder (not the raw value) via the third-party ticket-detail endpoint.
✓ A field with no sensitivity marking (or `internal`/`public`) passes through unredacted,
identical to today's behavior — this requirement narrows exposure, it doesn't hide non-sensitive
data.

R8: `admin_audit_log` detail rows older than 90 days are removed on a recurring sweep, while
aggregate counts (requests per endpoint, allowed-vs-denied ratios) survive that removal in a
separate rollup.
✓ A detail row created 91+ days ago is absent after the next sweep run, for an otherwise-active
tenant.
✓ The rollup's aggregate counters for that same period are unaffected by the detail-row
removal (queryable before AND after the sweep, same numbers).

R9: A tenant purge immediately anonymizes (does not delete) that tenant's `admin_audit_log`
rows, regardless of how much of the 90-day window remained.
✓ A row created 1 day before purge (nowhere near the 90-day sweep) is anonymized immediately
by the purge itself, not left to age out naturally.
✓ The anonymized row still exists (action type, resourceType/resourceId, outcome, timestamp
preserved) but every person-identifying field (`actorId` when it's a person id, `actingPersonId`)
is replaced with a fixed placeholder.
✓ An anonymized row is still queryable/filterable by action type and outcome, just not by the
original person identifier.

R10: A tenant purge immediately anonymizes that tenant's cached idempotency responses, the same
way R9 anonymizes `admin_audit_log` rows — the `idempotency_keys.response_body` column can
contain full ticket/comment content (PII), not just metadata, so R9's purge trigger must cover
this table too, not just `admin_audit_log`.
✓ A tenant purge deletes (not merely expires) that tenant's `idempotency_keys` rows outright —
unlike `admin_audit_log`, there's no operational-history reason to keep a placeholder row here,
since the cached response has no value once the tenant is gone.
✓ A purge run mid-way through an in-flight idempotency lock (the 30s lock, R5) does not leave a
stale lock blocking a future key reuse after the tenant is recreated/re-provisioned with the
same id (accepted as practically near-impossible given tenant ids are never reused, but the
lock's own TTL bounds this regardless).

R11: TLS is enforced (or its enforcement point is verified, not assumed) for every third-party
API request.
✓ Either an app-level check exists (e.g. `x-forwarded-proto` rejection when not `https`), OR a
documented verification that the actual reverse-proxy/infra layer enforces this — the spec's
`§B` records which one, not a guess.

R12: Phase F's known residual risk (sustained near-rate-limit-threshold activity evades the
volume-spike alert) is confirmed documented, not silently assumed covered.
✓ The admin-ui Phase F caveat text (already shipped) is confirmed still accurate and visible;
no new code needed unless the confirmation finds it's missing or stale.

R13: A full `/security-review` runs across the entire third-party API feature set (Phases A–G
combined) before this phase's PR(s) are considered mergeable.
✓ The review's findings are triaged (fixed/accepted/deferred) in the same review.json pattern
used for every other phase this session, with a final "ready for real external key issuance"
verdict.

## §V Invariants

- Every rate-limit tier reuses `@platform/redis`'s `checkRateLimit` sliding-window primitive and
  its fail-open-with-timeout philosophy (`packages/redis/src/rate-limit.ts`) — no tier gets a
  bespoke Redis pattern that skips the 250ms bounded-timeout guarantee already established.
- Idempotency's content-hash MUST use RFC 8785 JSON Canonicalization Scheme, not a naive
  `JSON.stringify` (key ordering is not guaranteed stable across HTTP client implementations).
- Idempotency scoping is always the 3-tuple `(api_key_id, tenant_id, acting_person_id)` together
  — never a 2-tuple, never global. A lookup missing any one of the three is a bug, not a
  relaxed/optional check.
- `admin_audit_log` anonymization (purge-triggered or age-triggered) NEVER deletes the row
  itself — only PII fields are replaced with placeholders. Aggregate operational history must
  survive both triggers.
- PII redaction on third-party reads uses the SAME `entityFields`/sensitivity-map mechanism
  already used for `writeAuditEntry`'s snapshot redaction and the connector-outbound-worker's
  payload redaction — never a second, parallel redaction implementation.
- The idempotency LOCK (R5) and the idempotency CACHE lookup (R3/R4) are always scoped by the
  identical 3-tuple `(api_key_id, tenant_id, acting_person_id)` — a bug that scopes the lock
  differently from the cache read would silently defeat R5's concurrency guarantee while R3/R4
  still pass in isolation (spec-review finding).
- Any new table storing third-party request/response content (`idempotency_keys`) is covered by
  tenant-purge's deletion sweep — a new PII-bearing table is never added without also adding it
  to the purge path in the same change (spec-review finding, mirrors R9/R10's relationship).

## §T Tasks

| id  | task                                                                                                                                                                                                 | phase | status | depends |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1  | Wire ADR-013's 3-tier rate limiting (per key+person, per key aggregate, per tenant) into third-party routes, reusing `checkRateLimit`                                                                | 1     | done   | —       |
| T2  | Per-tenant admin-editable rate-limit ceiling (new column/table + admin PATCH route only — no new admin-ui screen this phase; reuse the existing admin route conventions from `platform-settings.ts`) | 1     | done   | T1      |
| T3  | JWT `iat` max-age check (config-driven, default 15min, startup sanity warning); confirm interaction with the existing `clockTolerance: 5` at the 15-min boundary                                     | 1     | done   | —       |
| T4  | PII redaction wired into third-party ticket-detail and workflow-list read routes                                                                                                                     | 1     | done   | —       |
| T5  | TLS/HTTPS enforcement point — verify infra-level enforcement OR add an app-level check; document which                                                                                               | 1     | done   | —       |
| T6  | Idempotency: schema (`idempotency_keys` table), RFC 8785 canonicalization + content-hash helper                                                                                                      | 2     | done   | —       |
| T7  | Idempotency: 30s in-flight lock (409 + Retry-After) + 24h result-cache read/write, wired into create/comment/sub-ticket/transition routes                                                            | 2     | done   | T6      |
| T8  | Access-log retention: scheduled 90-day sweep job + aggregate rollup table                                                                                                                            | 3     | done   | —       |
| T9  | Tenant-purge: replace the current "retain forever" behavior with immediate anonymization of that tenant's `admin_audit_log` rows                                                                     | 3     | done   | T8      |
| T10 | Tenant-purge: extend the same purge path to delete that tenant's `idempotency_keys` rows outright (R10)                                                                                              | 3     | done   | T6, T9  |
| T11 | Confirm Phase F's residual-risk disclosure is still accurate/visible (verification only, code change only if it's found missing)                                                                     | 3     | done   | —       |
| T12 | Full end-to-end `/security-review` across Phases A–G + isolation tests for every new table/route + PR                                                                                                | 3     | done   | T1–T11  |

phase gate: all unit + isolation tests pass, `/security-review` clean, before each stage's PR opens

## §B Bugs / Backprop Log

| id  | what failed                                                                                                                                                                                                              | root cause                                                                                                                                                                                                                  | promoted to §V?                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Design doc's checklist listed "Tier 1 token-freshness: implemented in Phase B" as already done — false.                                                                                                                  | `packages/auth/src/jwks.ts`'s `jwtVerify` call only sets `clockTolerance: 5` (clock-skew leeway); no `maxTokenAge`/`iat` check exists anywhere in the auth package.                                                         | Yes — R6 added as a real requirement, not a confirmation-only task.                                                                    |
| B2  | Final `/security-review` (T12) found `admin_audit_log_daily_rollup`'s own migration comment claimed to follow a "no-RLS precedent" set by `admin_audit_log` — false, `admin_audit_log` has had RLS since migration 0011. | Comment was written from tenant-purge.ts's write-path description ("plain `db`, not withTenantContext") without checking whether that plain-`db` table itself has RLS — it does; RLS is orthogonal to which role writes it. | No — one-off documentation error, not a recurring class; fixed in the same migration file (0083) rather than promoted to an invariant. |

R11 resolution (recorded per its own acceptance criterion, not a bug): the app-level check branch was chosen — `apps/api/src/middleware/https-enforcement.ts`, production-only, rejects only when `x-forwarded-proto` is explicitly `http`. No reverse-proxy/infra config exists anywhere in this repo to verify instead, so the "documented infra verification" branch was not available; the app-level check is what satisfies R11 for this codebase today.

---

_spec is source of truth — update as decisions are made_
