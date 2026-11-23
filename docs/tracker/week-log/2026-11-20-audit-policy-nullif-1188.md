# 2026-11-20 — Audit log tenant policies tolerate a reset tenant setting (#1188)

## Done

- Migration `0165_audit_log_tenant_policy_nullif.sql` rewrites `audit_log_tenant_isolation` (`admin_audit_log`) and `admin_audit_log_daily_rollup_tenant_isolation` (`USING` and `WITH CHECK`) to `NULLIF(current_setting('app.tenant_id', true), '')::uuid`, as 0090 did for `api_keys`. An unset or reset tenant now matches no rows instead of throwing.
- New isolation test `apps/worker/tests/isolation/audit-policy-nullif.isolation.test.ts` saturates the pool with tenant transactions so every connection reads `app.tenant_id` as `''`, then:
  - runs the real `runAccessLogRetentionSweep` and checks both tenants are rolled up;
  - checks an `app_user` session whose tenant reads `''` sees no audit or rollup rows and does not throw;
  - checks a tenant session still sees only its own audit and rollup rows;
  - checks a tenant session cannot write a rollup row for another tenant.
- Reproduced before the fix: on current `main` the real access-log sweep throws `invalid input syntax for type uuid: ""` on such a pool, and the `''` session read throws the same. So the shipped sweep can hit this; it is not only a latent risk.

## Not done / for a human

- About 39 other tenant policies still use the bare cast (41 of 69 before this change). They have no known bare-query path; widening this to all of them is a separate decision.
- ADR-001 lines 165–174 prescribe `current_setting('app.tenant_id', true)::uuid` and call it fail-safe. It is not on a pooled connection. ADRs are human-written; it needs an amendment. `db-conventions.md` already requires `NULLIF`.
- **Numbering.** This was built as `0164` before #1184 (which also added a `0164`) merged. #1184 landed first, so this migration is renumbered to `0165` (journal `idx` 165, `when` 1793750400000, above #1184's 1793664000000). Drizzle skips any migration whose `when` is not strictly greater than the last applied one, so a later PR that still carries a `0164` (#1187 has `0164_tenant_settings`) must renumber after this lands, to `0166` or later with a `when` above 1793750400000.
- The rollup policy's `WITH CHECK` cannot be exercised through a real role: `app_user` has no `INSERT` grant on the table, so a cross-tenant write fails on the grant first. The test asserts the policy definitions instead.

## Verification

Fresh database `platform_test_1188r`, `main`'s 165 migrations plus this one (166), applied through the runner, Node 26:

- Before the migration, on a pool saturated with tenant transactions: the real `runAccessLogRetentionSweep` and an `app_user` read with the tenant reading `''` both throw `invalid input syntax for type uuid: ""` (2 of the 5 new tests fail; the other 3 pass).
- After: the 5 new tests pass, together with #1184's reporting-retention tests and the on-call file in one run (42/42). Worker isolation 155/155; API isolation 1180 passed, 9 skipped.
- `pnpm typecheck`, `pnpm lint` and `prettier --check` over the repo pass. `pnpm test` passes in every package; in one full run a single worker test (`oncall-rotation-worker.isolation.test.ts`, 5 s timeout under parallel load) failed, and passes alone (22/22) and in a rerun of the worker suite (720/720).
- Remaining bare-cast policies, counted the same way before and after: 41 → 39 of 69 that read `app.tenant_id`.
- Security review of the migration (policy probes in rolled-back transactions on a separate database): no isolation weakening. Unset, `''` and nil uuid match nothing; a set tenant sees only its own rows; a malformed value still raises, as before. Its smaller findings were fixed or recorded above. The renumber from `0164` to `0165` changed no SQL beyond the header.
