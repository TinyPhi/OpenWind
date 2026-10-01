# 2026-08-26 — Third-party API Phase G Hardening, Phase 2 (T6-T7)

Spec: `docs/specs/third-party-api-phase-g-hardening.md` (+ `-tasks.md`)
ADR: ADR-012 (third-party API access to tickets)
Branch: `feat/third-party-api-phase-g-idempotency` (based on
`feat/third-party-api-phase-g-hardening`, Phase 1, PR #495)

## Done

- **T6** — `idempotency_keys` table (migration `0082_idempotency_keys.sql`,
  unique on `tenant_id, api_key_id, acting_person_id, idempotency_key`, RLS
  - explicit tenant filters, `SELECT/INSERT/DELETE` grants only — rows are
    never updated). RFC 8785 JSON Canonicalization Scheme content-hash helper
    (`apps/api/src/lib/idempotency.ts`'s `computeContentHash`) via the
    `canonicalize` npm package (the JCS reference implementation) — not a
    naive `JSON.stringify`, per the spec's own invariant.
- **T7** — `withIdempotency` helper: on a same-key-same-content replay,
  returns the cached response without re-executing (including skipping
  fire-and-forget side effects like outbox writes and mention-resolution
  enqueue); on a same-key-different-content retry, returns `409` without
  executing; on two concurrent identical requests, a 30s Redis `SET NX`
  lock (`idempotency-lock:<tenantId>:<apiKeyId>:<personId>:<key>`) ensures
  exactly one executes, the other gets `409` + a `retryAfterSeconds` hint.
  Wired into all four mutating third-party routes: ticket create
  (`tickets.ts`), comment create (`comments.ts`), sub-ticket create
  (`children.ts`), and transition execute (`transitions.ts`) — all keyed
  off the `Idempotency-Key` HTTP header, deliberately kept separate from
  `transitions.ts`'s own pre-existing `idempotencyKey` JSON body field
  (a narrower, unrelated workflow-engine event-dedup mechanism).
  Idempotency wraps only the mutating action itself, not upstream
  validation/access checks, so a request that 422'd on bad input re-
  validates fresh on retry rather than replaying a cached failure.

## Verification

- `pnpm typecheck`: PASS (full workspace)
- `pnpm lint`: PASS (full workspace, `--max-warnings=0`)
- `pnpm test`: PASS — 636/636 unit tests in `apps/api` (idempotency helper:
  9 new unit tests covering replay, conflict, concurrent-lock, fail-open,
  and lock-release-on-error), plus all previously-passing suites.
- `pnpm test:isolation`: not runnable this session — Docker/OrbStack stack
  down for the entire session (same pre-existing environment issue as
  Phase 1). New isolation test
  (`tests/isolation/third-party-idempotency.isolation.test.ts`, covering
  R3/R4/R5 through a real route) is written and confirmed to load/structure
  correctly (fails only on `ECONNREFUSED` to Redis, never on test logic).
  Must be re-run for real before merge.
- `/review`: clean, no correctness findings.
- `/security-review`: initial pass found 4 items — 2 fixed, 2 informational/deferred:
  - **Fixed**: unbounded `Idempotency-Key` header length (no Zod validation, unlike
    `transitions.ts`'s own pre-existing `idempotencyKey` body field's `.max(255)`)
    — added the same 255-char cap directly in `withIdempotency`, rejecting with
    `400 IDEMPOTENCY_KEY_INVALID` before any DB/Redis call.
  - **Fixed**: the cache lookup never checked `expiresAt`, so a 24h-old row would
    still be served as valid forever (no sweep job exists yet to delete it) —
    added an `expiresAt`-filtered lookup, plus a delete-if-expired step before
    the insert (an `onConflictDoNothing` alone would otherwise silently no-op
    against the stale row, permanently freezing the cached response).
  - **Deferred to Phase 3 (T10)**, confirmed as an accepted, already-scoped gap:
    `idempotency_keys` isn't yet included in tenant-purge.
  - **Documented, not fixed**: a request that outlives the 30s lock TTL can race
    a second request that reuses the now-expired lock, in principle producing
    two persisted results under one key — added an explicit code comment;
    extending/refreshing the TTL is a larger change deferred for now.
  - Also added isolation-test coverage proving the 4-tuple scope (cross-tenant
    and cross-acting-person reuse of an identical key+content executes
    independently, not a cache hit) — flagged by the review as a real coverage
    gap (the initial isolation test only varied the key string within one scope).

## Next

- Phase 3 (T8-T12): access-log retention sweep + rollup table, tenant-purge
  anonymization for `admin_audit_log`, tenant-purge deletion of
  `idempotency_keys` (R10 — already scoped for this in the migration's
  analytics annotation), Phase F residual-risk disclosure confirmation, and
  the final cross-phase `/security-review` before Phase G is considered
  closed.
- Re-run `pnpm test:isolation` for real once Docker/OrbStack is available,
  for both this phase's and Phase 1's isolation tests.
