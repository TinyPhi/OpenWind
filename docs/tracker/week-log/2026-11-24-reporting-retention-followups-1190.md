# 2026-11-24 — Reporting retention follow-ups from the #1184 review (#1190)

Option A from the owner: everything in #1190 except G3, which needs a migration.

## Done

- **G2** `runAccessLogRetentionSweep` runs the access-log sweep and the reporting-audit sweep
  independently. A throw in one no longer skips the other, each failure is logged under its own
  name, and the job still fails afterwards (the single error, or an `AggregateError` for both).
  Both sweeps log a `warn` when the loop ends at `MAX_*_BATCHES_PER_RUN` with a full last batch.
- **G4** `anonymizeAuditLogForTenant` strips `metadata - 'sql'` in batches of 1000
  (`WHERE id IN (SELECT id ... LIMIT 1000) RETURNING id`, until a short batch) instead of one
  unbatched `UPDATE`.
- **S1** New `withTenantPurgeRoleSavepoint` in `@platform/db`; `pseudonymiseReportingAuditActor`
  uses it. `user-erasure.ts` no longer has an inline `SET LOCAL ROLE`.
- **S2** `UserErasureResult.reportingAuditRowsPseudonymised`, also written to the erase audit row's
  metadata, as evidence for criterion 21.
- **S3** `test_audit_mapping.py` removes its fake `superset` package (sys.path entry, modules, temp
  dir) in `tearDownModule`; a new test pins it.
- **S4** `docs/runbooks/superset-erasure.md` records that rows written before #1184 keep raw SQL
  until the retention sweep, and lists the redactor's three known limits.

## Not done

- **G3** (partial index for the reporting retention query). It needs a migration, and #1187 still
  has to renumber its own `0164` to `0166` or later. Take the next free number after #1187 lands.
- Whether to **accept the redactor's known limits** is still the owner's call; the runbook states
  them as facts and says the question is open.
- The roadmap tracker's 3G row is not touched here: #1193 edits it, and a second edit would conflict.

## Found

- The #1190 text says S1 wraps the role switch "like the other role switches", but those are all
  top-level (`withTenantPurgeContext` opens its own transaction). Per-user erasure runs inside the
  caller's `withTenantContext`, so the helper uses a savepoint and keeps the caller's `app.tenant_id`.
- While verifying, a `brew upgrade` on the machine replaced `simdutf` and `simdjson`, which broke the
  installed Node for about ten minutes; it recovered when the upgrade finished (Node 26.13.1).
  Nothing in the repo was involved.

## Verification

- `pnpm typecheck`: PASS (52 tasks). `pnpm lint`: PASS (52 tasks, `--max-warnings=0`).
- `pnpm test`: PASS except one timeout, `oncall-rotation-worker.isolation.test.ts > advance notice`
  (5 s under parallel load; it passes alone, 22/22, and the same test was recorded flaky in the #1188
  week-log). Turbo stopped after it, so `@platform/api` and `@platform/admin-ui` were run separately:
  admin-ui 1296/1296; api 2788 passed, and one file failed to seed because the database had already
  been used by an earlier run of the same file. It passes on a fresh database (next line).
- `pnpm test:isolation` on a fresh database (migrations 0000–0165): worker 166/166, api 1193 passed,
  9 skipped.
- Python: `python3 -m unittest` over `test_audit_mapping.py` and `test_nullpool_guard.py`, in both
  orders, passes with the same skip count as `main` (the real-database and real-Superset tests skip).
- New tests: worker unit tests for failure isolation and the batch-cap warning (both sweeps), an audit
  unit test for the batching, db unit tests for the helper, a route test for the audit metadata,
  an api isolation assertion for the count, an api isolation test that `current_user` is
  `tenant_purge_role` inside the helper and `app_user` after it (also when the callback throws), and a
  worker isolation test with 2,500 SQL-bearing rows through the real `tenant_purge_role`.
- Security review (read-only `security-reviewer` agent, one pass over the diff): no blocking or medium
  findings. Two low notes: the helper does not itself assert `app.tenant_id` is set (a misuse fails
  closed under the 0165 policy), and the mocked helper test did not prove the role reverts, which the
  api isolation test above now does. No full `/review` fan-out was run; the diff is about 400 lines.

## Housekeeping

- Local throwaway databases `platform_test_1190a` and `platform_test_1190b` were created on
  `ow-database` (which was stopped and was started for this). They need manual cleanup by the owner;
  the destructive guard blocks `DROP DATABASE`.
