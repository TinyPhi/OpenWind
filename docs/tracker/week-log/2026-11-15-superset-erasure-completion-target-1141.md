# 2026-11-15 — Define and monitor Superset erasure completion target (#1141)

## Done

- `docs/runbooks/superset-erasure.md`: documented the statutory 30-day completion target under GDPR Article 17(1) for Superset user erasures and tenant purges, and documented the operator escalation runbook for the Day-7 warning alert `SupersetErasurePending7d`.
- `docker/observability/alert.rules.yml`: added `SupersetErasurePending7d` warning alert rule with `for: 7d` evaluating `openwind_superset_erasure_unreconciled_older_than_1h > 0` grouped by `tenant_id` and `subject_hash` (pseudonymous `resource_id` from `admin_audit_log`, never raw personal data).
- `docker/observability/alert.rules.test.yml`: added promtool unit test case verifying `SupersetErasurePending7d` alert fires at day 7 (10,080m) and clears when the unreconciled series drops to 0 upon completion.
- `apps/worker/src/superset-erasure-reconcile.ts`:
  - Extended lookback window from 7 days to 30 days (`cutoff30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)`) to cover the entire statutory completion target window.
  - Added support for reconciling tenant purges (`resourceType: 'tenant'`, `action: 'purge.completed'`) alongside user erasures.
  - Extracted unreconciled entries (`{ tenantId, subjectHash }`) for all rows older than 1 hour and stored them via `writeSupersetUnreconciledEntries()`.
- `packages/redis/src/superset-selfcheck.ts`: added `SUPERSET_UNRECONCILED_ENTRIES_KEY`, `UnreconciledErasureEntry` interface, `writeSupersetUnreconciledEntries()`, and `readSupersetUnreconciledEntries()`. Re-exported from `@platform/redis`.
- `packages/telemetry/src/metrics.ts`: updated `openwind_superset_erasure_unreconciled_older_than_1h` observable gauge callback to read unreconciled entries from Redis and observe labelled `{ tenant_id, subject_hash }` metric series (and observe 0 when empty).

## Verification

- `docker run ... promtool check rules /r/alert.rules.yml` and `promtool test rules /r/alert.rules.test.yml`: passed with all 18 rules validated.
- `packages/telemetry`: verified `alert-rules.test.ts`, `metrics.test.ts`, and all test suites passed (5 test files, 42 tests).
- `packages/redis/src/superset-selfcheck.test.ts`: verified all 23 tests passed, including write/read roundtrip for unreconciled entries and empty array reset on 0.
- `apps/worker/src/superset-erasure-reconcile.test.ts`: verified all 13 tests passed, including tenant purge sweep, entry collection, and 30-day window.
