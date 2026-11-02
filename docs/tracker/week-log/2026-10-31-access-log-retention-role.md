# 2026-10-31 — access-log retention under app_user: access_log_retention_role

**Session type:** Bug found while checking the stack (retention job never deleted anything)
**Spec:** ADR-012 Phase G, R8
**Branch:** `fix/PLAT-1131-audit-retention-role`
**Issue:** #1131

- **Symptom.** `access-log-retention.ts` failed with `permission denied for table admin_audit_log`
  on every run.
- **Cause.** The worker connects as `app_user`, which has INSERT+SELECT only on `admin_audit_log`
  (0061). The job's comment assumed a privileged connection. CI connects as a superuser, so no
  test noticed (same blind spot as 0143/0144).
- **Fix (owner chose the narrow-role option).** Migration `0158_access_log_retention_role.sql`
  adds `access_log_retention_role` (NOLOGIN, NOBYPASSRLS, granted to app_user WITH INHERIT FALSE).
  Grants: SELECT of five columns plus DELETE on `admin_audit_log`; SELECT, INSERT of the data
  columns and UPDATE(count) on the daily rollup. Audit-log policies are bounded to rows older
  than 90 days (security review), so a session in this role cannot touch recent audit rows.
  `setAccessLogRetentionRole(tx)` is used inside the batch transaction. `app_user` is not widened.
- **Tests.** Isolation tests run the batch as the narrow role (including the ON CONFLICT upsert),
  and prove `app_user` still cannot delete or update, the role cannot touch PII columns, other
  tables or recent rows, and it is NOLOGIN and NOBYPASSRLS.
- **Residual risk.** As with the other SET ROLE roles, switching in is possible from any app_user
  session (code discipline is the boundary); the role can also write rollup rows for any tenant.
  RETENTION_DAYS (90) is duplicated in the migration policy; change both together.
