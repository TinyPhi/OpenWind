# 2026-10-12 — sandbox worker audit writes rejected by RLS

**Session type:** Bug fix (found in manual testing)
**Spec:** `docs/specs/multi-org-sandbox.md` T7, T13, T15
**Branch:** `fix/sandbox-worker-audit-tenant-context`

- Manual testing of sandbox creation: the provisioning job failed, and its failure audit write
  then failed too. The cause is that the provisioning, reset and delete workers wrote
  `admin_audit_log` through the plain `db` connection. That table is RLS-protected, and the
  worker connects as `app_user` (`docker-compose.yml`), so with no tenant GUC set the insert
  is rejected every time (`new row violates row-level security policy`, reproduced directly
  in Postgres).
- The impact was worse than a missing audit row. In provisioning the `*_completed` write sits
  inside the `try` whose `catch` runs the T11 rollback, so a sandbox that built successfully
  would fail at its final step and delete itself. Reset and delete would report failure after
  doing their work.
- Fix: each worker's `auditOutcome` now writes inside `withTenantContext(tenantId)`, which is
  what every other worker does (export, mention-resolution, schedule-tick) and what the
  provisioning worker's own header already claimed. It still works after a provisioning
  rollback deleted the tenant row: the policy only compares `tenant_id`, and there's no FK.
- Why nothing caught it: unit tests mock `@platform/db`, and the isolation suite connects as a
  superuser, which bypasses RLS. Running a worker job in an isolation test doesn't help either,
  since its plain `db` write passes there. The new
  `sandbox-audit-tenant-context.isolation.test.ts` proves the database rule (rejected as
  `app_user` without a tenant, accepted through `withTenantContext`), and new unit tests prove
  each worker writes through `withTenantContext` on both outcomes. All six fail against the
  pre-fix workers.
- Also: a missing sandbox provisioning key (`ZITADEL_PROVISIONING_KEY_JSON` /
  `ZITADEL_PROVISIONING_SERVICE_ACCOUNT_KEY`) is now logged as an explicit error. Before, the
  job just failed with `SANDBOX_ORG_CREATE_FAILED` and nothing in the logs said why.
- Follow-up, not changed here: `tenant-purge.ts` also writes `admin_audit_log` on plain `db`,
  and its comments assume the worker connection is privileged. Under the compose setup that
  doesn't hold, so it needs the same check separately.
