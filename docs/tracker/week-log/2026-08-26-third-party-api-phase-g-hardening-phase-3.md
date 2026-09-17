# 2026-08-26 — Third-party API Phase G Hardening, Phase 3 (T8-T12, closing gate)

Spec: `docs/specs/third-party-api-phase-g-hardening.md` (+ `-tasks.md`)
ADR: ADR-012 (third-party API access to tickets)
Branch: `feat/third-party-api-phase-g-retention` (based on `feat/third-party-api-phase-g-idempotency`,
Phase 2, PR #499)

This is the final phase of ADR-012 Phase G — all of T1-T12 are now done.

## Done

- **T8** — new `apps/worker/src/access-log-retention.ts`: a daily (03:00) BullMQ
  recurring job that batches (5000 rows, up to 20 batches/run) `admin_audit_log`
  rows older than 90 days, aggregates each batch by
  (tenant, day, resource_type, action) into the new `admin_audit_log_daily_rollup`
  table, then deletes the detail rows — aggregate-then-delete happens as one
  atomic SQL statement (three chained CTEs) per batch, so a crash between the
  rollup upsert and the delete is impossible mid-batch.
- **T9** — `apps/worker/src/tenant-purge.ts` now calls the new
  `anonymizeAuditLogForTenant` (`@platform/audit`) instead of leaving that
  tenant's `admin_audit_log` rows untouched forever: `actorId` is replaced
  with `[purged]` only on `actorType: 'user'` rows (an `api_key` row's
  `actorId` is an application identity, not a person, and is left alone),
  and `actingPersonId` is always replaced with `[purged]` whenever set
  (it's always a real person identifier per ADR-012 Phase B/GAP-05,
  regardless of actorType). Action/resourceType/resourceId/createdAt are
  untouched and remain queryable.
- **T10** — the same purge transaction now deletes that tenant's
  `idempotency_keys` rows outright (not anonymized — `response_body` can
  contain full ticket/comment PII, no operational-history reason to keep a
  placeholder row here, unlike `admin_audit_log`).
- **T11** — confirmed Phase F's residual-risk disclosure
  (`apps/admin-ui/src/pages/third-party-access-logs.tsx`'s "Known residual
  risk" callout) is still present, visible, and accurate: Phase G's rate
  limits reject requests over a hard threshold but add no behavioral/anomaly
  detection, so sustained-just-under-threshold activity still evades Phase
  F's volume-spike alert exactly as disclosed. No code change needed.
- **T12** — ran a full end-to-end `/security-review` across the entire
  third-party API feature set (Phases A-G combined), not just this
  session's diff. Initial verdict was **not ready** — two blocking findings,
  both fixed in this same session before re-declaring the gate closed:
  - `admin_audit_log_daily_rollup` (T8's new table) shipped with no RLS
    policy, and its own migration comment incorrectly claimed to follow a
    "no-RLS precedent" set by `admin_audit_log` — `admin_audit_log` has had
    RLS since migration 0011. Fixed: added the RLS policy pair to migration
    `0083_admin_audit_log_daily_rollup.sql`, corrected the comment, logged
    as spec `§B` entry B2 (a one-off documentation error, not promoted to
    an invariant).
  - R11 (TLS enforcement) requires recording in `§B` which of its two
    branches was chosen (app-level check vs. documented infra
    verification) — the app-level check (`https-enforcement.ts`) was built
    in Phase 1 but never explicitly recorded as the chosen branch. Fixed:
    added an explicit R11 resolution note to the spec.
  - Two non-blocking findings also fixed as cheap wins: `PATCH
/admin/tenants/:id/rate-limit` had no audit trail (every sibling
    tenant-lifecycle mutation writes one) — added `writeAuditEntry` with
    before/after rate-limit snapshots. `idempotency_keys` rows for an
    active tenant have no independent sweep once past their 24h TTL (only
    a lazy delete-on-next-collision) — left as a documented follow-up, not
    built now (matches the reviewer's own non-blocking framing).
  - Everything else the review checked came back solid: two-layer tenant
    isolation across every new/changed table this whole feature spans,
    consistent 3-tier rate limiting, JWT `iat` max-age correctly scoped to
    only the third-party path, idempotency's lock/cache scope consistency,
    PII redaction reusing the one existing mechanism, 404-not-403
    consistently upheld, and a genuinely cross-tenant idempotency isolation
    test (not a hollow one).

## Verification

- `pnpm typecheck`: PASS (full workspace)
- `pnpm lint`: PASS (full workspace, `--max-warnings=0`)
- `pnpm test`: PASS — 643/643 `apps/api` unit tests, 244/244 `apps/worker`
  unit tests (5 new for the retention sweep's batching/loop-termination
  logic; 1 new + 1 updated for `anonymizeAuditLogForTenant` in
  `@platform/audit`).
- `pnpm test:isolation`: not runnable this session (Docker/OrbStack down
  for the entire session, same pre-existing environment issue as Phases
  1-2). New isolation test
  (`apps/worker/tests/isolation/tenant-purge-audit-idempotency.isolation.test.ts`,
  covering R9/R10 through the real purge processor) and the updated
  `tenant-rate-limit.isolation.test.ts` (now also asserting the new audit
  row) are written and confirmed to load/structure correctly (fail only on
  `ECONNREFUSED`, never on test logic). Must be re-run for real before
  merge.
- `/review`: clean.
- `/security-review` (T12, full cross-phase): 2 blocking + 2 non-blocking
  findings, all 4 fixed in this session (see T12 above). Re-verify is
  recommended once `pnpm test:isolation` can actually run, but no further
  code changes are anticipated from that alone.

## Next

- All of ADR-012 Phase G (T1-T12) is now implemented across three stacked
  PRs (#495 Phase 1, #499 Phase 2, and this branch's Phase 3). Once
  Docker/OrbStack is available, run `pnpm test:isolation` for real across
  all three phases before merging.
- After merge, Phase G's own stated goal — a real external test key can be
  issued — is unblocked, pending the actual human PR reviews and the
  isolation-test re-run above.
