# 2026-10-14 — tenant purge under app_user: tenant_purge_role

**Session type:** Bug found in manual testing (sandbox delete never finished)
**Spec:** `docs/specs/multi-org-sandbox.md` R8 (delete) / T14
**Branch:** `fix/tenant-purge-role`
**Issues closed:** #903 (`anonymizeAuditLogForTenant runs on plain db — app_user not granted UPDATE on admin_audit_log`)

- **Symptom.** Deleting a sandbox flipped it to `deleted` and queued a purge, but the purge
  failed on `delete from schedule_executions`. The row stayed on the dashboard, and a second
  delete returned a bare 500 (`SANDBOX_DELETE_INVALID_TENANT_STATUS`).
- **Cause.** tenant-purge's privileged pre-steps ran on plain `db`, which its comments assumed
  was a privileged connection. Under compose it is `app_user`:
  - `schedule_executions` is append-only for app_user (INSERT+SELECT), so the delete errored;
  - with no `app.tenant_id` set, RLS hid every row, so the `schedule_rules` archive, the
    `saved_views` delete and the `admin_audit_log` anonymization silently matched nothing. A
    "completed" purge would have left real person identifiers in the audit log.

  CI connects as a superuser, the same blind spot as #869's `tenants` grants.

- **Fix (owner chose the narrow-role option).** Migration `0144_tenant_purge_role.sql` adds
  `tenant_purge_role` (NOLOGIN, NOBYPASSRLS, granted to app*user WITH INHERIT FALSE) with only:
  DELETE on `schedule_executions` and `saved_views`, UPDATE(status) on `schedule_rules`, SELECT
  on `tenant_users`, and UPDATE of the person-identifying `admin_audit_log` columns. It also adds a
  `saved_views` policy for this role that doesn't need `app.user_id`. `withTenantPurgeContext`
  switches into the role \_and* sets `app.tenant_id`, so tenant RLS still confines every statement.
  `anonymizeAuditLogForTenant` now accepts the purging tenant's own context but still refuses
  another tenant's.
- **Delete UX.** 0144 lets `platform_admin_role` read `tenants.status`, so:
  - the sandbox list omits deleted/purged sandboxes;
  - a repeat delete returns 409 `SANDBOX_ALREADY_DELETED` without queueing a job;
  - the delete worker checks the status before calling Zitadel.
- **Tests.** A new isolation test exercises the real pre-steps under the role:
  - tenant A is cleared and tenant B is untouched, even for an unfiltered DELETE;
  - plain app_user is still refused;
  - the role can't rewrite `action`;
  - an app_user session can switch into the role.

  Unit tests pin that no pre-step write goes through plain `db`, and cover the 409 and the
  list filter.

- **Open:** a human-authored ADR note for the narrow-role pattern, now covering both
  `tenant_lifecycle_role` (0143) and `tenant_purge_role` (0144).
