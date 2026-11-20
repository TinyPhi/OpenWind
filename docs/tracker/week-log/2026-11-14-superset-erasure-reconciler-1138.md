# 2026-11-14 — Reconcile unqueued Superset user erasures (#1138)

## Done

- `apps/worker/src/superset-erasure-reconcile.ts`: implemented repeatable BullMQ worker sweep `superset-erasure-reconcile` running every 5 minutes (when Superset erasure mode is "full"). It sweeps active tenants with `listSweepTenants()` and `forEachTenant()` under `withTenantContext()` (respecting ADR-001 RLS without `BYPASSRLS`).
- Selects `admin_audit_log` rows with `resource_type = 'user'`, `action = 'deleted'`, `metadata->>'wasMember' = 'true'` within the last 7 days lacking sibling `superset_erasure.completed` or terminal `superset_erasure.failed` rows.
- Re-enqueues unreconciled erasures via `enqueueSupersetErasure()`. Idempotency is preserved by checking `supersetErasureJobId()` in BullMQ before enqueueing.
- Increments `openwind_superset_erasure_total{outcome="reconciled"}` on newly re-queued jobs.
- `apps/api/src/routes/platform/users.ts`: recorded `wasMember` in the `deleted` user audit row metadata (`metadata: { userId: targetUserId, wasMember }`). Pre-Stage-2 erasures lack this attribute, bounding them out and preventing no-op job storms.
- `apps/api/src/lib/superset-erasure-queue.ts`: updated `queue_failed` message to state it could not be scheduled immediately and will be retried automatically.
- `packages/redis/src/superset-selfcheck.ts`: added `writeSupersetUnreconciledCount` and `readSupersetUnreconciledCount` for gauge tracking in Redis.
- `packages/telemetry/src/metrics.ts`: added `openwind_superset_erasure_unreconciled_older_than_1h` observable gauge.
- `docker/observability/alert.rules.yml`: added `SupersetErasureUnreconciled` alert for unreconciled erasures older than 1 hour. Tested via promtool in `alert.rules.test.yml`.
- `docs/runbooks/superset-erasure.md`: removed "nothing retries it: run the erase by hand"; documented the automated reconciler and the persistent gauge alert.
- `apps/worker/src/index.ts`: wired `scheduleSupersetErasureReconcile()` and `stopSupersetErasureReconcileWorker()`.

## Verification

- `apps/worker/src/superset-erasure-reconcile.test.ts`: verified all 12 reconciler test scenarios (full mode check, tenant sweep, idempotency, older-than-1h gauge counting, unverified retry, corruption handling, scheduling).
- `apps/worker/src/worker-entry-wiring.test.ts`: verified worker entry point import and shutdown wiring.
- `apps/api/src/routes/platform/users.test.ts`: verified `wasMember: true` audit row metadata on user deletion.
- `apps/api/src/lib/superset-erasure-queue.test.ts`: verified `queue_failed` messaging and `outcome="reconciled"` metric initialization.
- Full API unit test suite (136 test files, 1500 tests) and Worker unit test suite (49 test files, 561 tests) passed.
- `promtool check rules` and `promtool test rules` passed with 17 rules validated.
- `pnpm typecheck` (34 packages) and `pnpm lint` passed with 0 errors.
