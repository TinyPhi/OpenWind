-- analytics: excluded (no new table — CHECK constraint update only)
--
-- ADR-012 Phase E, spec R3: the third-party status-transition route
-- (apps/api/src/routes/third-party/transitions.ts) writes 2 new audit
-- actions -- transition.executed (success) and transition.access_denied
-- (every denied attempt, including a granted-but-not-owner rejection) --
-- added to @platform/audit's AuditAction TS union in the same commit but
-- never added to this table's action CHECK constraint allowlist
-- (0011_admin_audit_log.sql). Extended proactively, in the same commit as
-- the TS union change, per the Phase C B1 incident's self-imposed rule
-- (every unit/isolation test around a route like this mocks @platform/db
-- unless it specifically targets a real Postgres instance, so a forgotten
-- CHECK-constraint update would otherwise ship silently broken).
--
-- Rollback:
--   ALTER TABLE admin_audit_log DROP CONSTRAINT audit_log_action_check;
--   ALTER TABLE admin_audit_log
--     ADD CONSTRAINT audit_log_action_check
--     CHECK (action IN ('created', 'updated', 'deleted', 'transitioned', 'restored', 'purge.completed', 'purge.failed'));

ALTER TABLE admin_audit_log DROP CONSTRAINT audit_log_action_check;

ALTER TABLE admin_audit_log
  ADD CONSTRAINT audit_log_action_check
  CHECK (action IN ('created', 'updated', 'deleted', 'transitioned', 'restored', 'purge.completed', 'purge.failed', 'transition.executed', 'transition.access_denied'));
