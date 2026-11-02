-- Migration: 0158_access_log_retention_role
-- analytics: excluded (role, grants and RLS policies only -- no new table)
--
-- Fixes #1131: access-log-retention.ts (ADR-012 Phase G, R8) runs a chained-CTE DELETE on
-- admin_audit_log via the shared `db`, assuming "the privileged DB connection". The worker
-- actually connects as app_user (docker-compose.yml), which has INSERT+SELECT only on
-- admin_audit_log (append-only, 0061), and under RLS with no app.tenant_id it would see no rows
-- anyway. So every run failed with "permission denied for table admin_audit_log". CI connects as
-- a superuser, which is why no test noticed (same blind spot as 0143/0144).
--
-- Fix: a dedicated NOLOGIN role, NOT BYPASSRLS, that the retention batch opts into with
-- SET LOCAL ROLE (db.transaction, same mechanism as tenant_purge_role / outbox_sweeper). The sweep
-- is cross-tenant by design (no single tenant to scope to), so RLS stays enabled and the role gets
-- explicit permissive policies (USING true) limited to the exact commands it needs, rather than a
-- BYPASSRLS attribute. Grants are column-scoped to what the CTE reads and writes:
--   admin_audit_log:             SELECT (id, tenant_id, resource_type, action, created_at), DELETE
--   admin_audit_log_daily_rollup: SELECT, INSERT (5 data columns), UPDATE (count)
-- app_user is NOT widened: it still cannot DELETE from admin_audit_log. Membership is granted
-- WITH INHERIT FALSE so an ordinary request never holds these privileges unless it explicitly
-- switches role. As with the other SET ROLE roles, the real boundary is code discipline: only
-- access-log-retention.ts issues this SET ROLE.
--
-- DOWN MIGRATION:
--   DROP POLICY IF EXISTS "admin_audit_log_retention_select" ON "admin_audit_log";
--   DROP POLICY IF EXISTS "admin_audit_log_retention_delete" ON "admin_audit_log";
--   DROP POLICY IF EXISTS "admin_audit_log_daily_rollup_retention_select" ON "admin_audit_log_daily_rollup";
--   DROP POLICY IF EXISTS "admin_audit_log_daily_rollup_retention_insert" ON "admin_audit_log_daily_rollup";
--   DROP POLICY IF EXISTS "admin_audit_log_daily_rollup_retention_update" ON "admin_audit_log_daily_rollup";
--   REVOKE SELECT, INSERT, UPDATE ON admin_audit_log_daily_rollup FROM access_log_retention_role;
--   REVOKE SELECT, DELETE ON admin_audit_log FROM access_log_retention_role;
--   REVOKE USAGE ON SCHEMA public FROM access_log_retention_role;
--   REVOKE access_log_retention_role FROM app_user;
--   DROP OWNED BY access_log_retention_role;
--   DROP ROLE IF EXISTS access_log_retention_role;

-- The audit-log policies are bounded to rows already past the retention window (90 days, the
-- same value as RETENTION_DAYS in access-log-retention.ts -- change both together), so a session
-- that switches into this role cannot erase recent audit evidence or read recent activity.
-- The rollup policies stay (true): the rollup is the aggregate record, written only by this role.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'access_log_retention_role') THEN
    CREATE ROLE access_log_retention_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE access_log_retention_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

GRANT access_log_retention_role TO app_user WITH INHERIT FALSE;
GRANT USAGE ON SCHEMA public TO access_log_retention_role;

GRANT SELECT (id, tenant_id, resource_type, action, created_at), DELETE
  ON admin_audit_log TO access_log_retention_role;

GRANT SELECT,
  INSERT (tenant_id, day, resource_type, action, count),
  UPDATE (count)
  ON admin_audit_log_daily_rollup TO access_log_retention_role;

DROP POLICY IF EXISTS "admin_audit_log_retention_select" ON "admin_audit_log";
CREATE POLICY "admin_audit_log_retention_select"
  ON "admin_audit_log" FOR SELECT TO access_log_retention_role
  USING (created_at < now() - interval '90 days');
DROP POLICY IF EXISTS "admin_audit_log_retention_delete" ON "admin_audit_log";
CREATE POLICY "admin_audit_log_retention_delete"
  ON "admin_audit_log" FOR DELETE TO access_log_retention_role
  USING (created_at < now() - interval '90 days');

DROP POLICY IF EXISTS "admin_audit_log_daily_rollup_retention_select" ON "admin_audit_log_daily_rollup";
CREATE POLICY "admin_audit_log_daily_rollup_retention_select"
  ON "admin_audit_log_daily_rollup" FOR SELECT TO access_log_retention_role USING (true);
DROP POLICY IF EXISTS "admin_audit_log_daily_rollup_retention_insert" ON "admin_audit_log_daily_rollup";
CREATE POLICY "admin_audit_log_daily_rollup_retention_insert"
  ON "admin_audit_log_daily_rollup" FOR INSERT TO access_log_retention_role WITH CHECK (true);
DROP POLICY IF EXISTS "admin_audit_log_daily_rollup_retention_update" ON "admin_audit_log_daily_rollup";
CREATE POLICY "admin_audit_log_daily_rollup_retention_update"
  ON "admin_audit_log_daily_rollup" FOR UPDATE TO access_log_retention_role USING (true) WITH CHECK (true);
