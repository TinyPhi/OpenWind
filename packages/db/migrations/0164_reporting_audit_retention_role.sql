-- Migration: 0164_reporting_audit_retention_role
-- analytics: excluded (role, grants and RLS policies only -- no new table)
--
-- ADR-019 Stage 2 criterion 14 (#1139): reporting.* rows in admin_audit_log
-- have a retention cap as a setting (REPORTING_AUDIT_RETENTION_DAYS, default 90 days),
-- swept by the worker retention sweep through a narrow role (same pattern as
-- access_log_retention_role, migration 0158).
--
-- Grants and policies:
--   admin_audit_log: SELECT (id, tenant_id, resource_type, action, created_at), DELETE
--   RLS policies confine the role strictly to action LIKE 'reporting.%' AND
--   created_at < now() - interval '30 days', so a session that switches into this role
--   cannot erase recent reporting audit evidence (the same age bound as 0158). 30 days
--   is the floor; REPORTING_AUDIT_RETENTION_DAYS is validated to 30..90.
--   A RESTRICTIVE policy repeats that bound for the role: audit_log_tenant_isolation (0011)
--   is FOR ALL with no TO clause, so it applies to this role too, and permissive policies are
--   OR'd. Without the restrictive policy, a session that had app.tenant_id set before the
--   SET ROLE could see and delete every row of that tenant, whatever its age or action.
--   app_user is granted membership WITH INHERIT FALSE
--
-- DOWN MIGRATION:
--   DROP POLICY IF EXISTS "admin_audit_log_reporting_retention_select" ON "admin_audit_log";
--   DROP POLICY IF EXISTS "admin_audit_log_reporting_retention_delete" ON "admin_audit_log";
--   DROP POLICY IF EXISTS "admin_audit_log_reporting_retention_bound" ON "admin_audit_log";
--   REVOKE SELECT, DELETE ON admin_audit_log FROM reporting_audit_retention_role;
--   REVOKE USAGE ON SCHEMA public FROM reporting_audit_retention_role;
--   REVOKE reporting_audit_retention_role FROM app_user;
--   DROP OWNED BY reporting_audit_retention_role;
--   DROP ROLE IF EXISTS reporting_audit_retention_role;

DO $$
DECLARE
  r pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pg_roles WHERE rolname = 'reporting_audit_retention_role';
  IF NOT FOUND THEN
    CREATE ROLE reporting_audit_retention_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
    RETURN;
  END IF;

  IF r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication THEN
    IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
      ALTER ROLE reporting_audit_retention_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
    ELSE
      RAISE EXCEPTION
        'role reporting_audit_retention_role already exists with unsafe attributes (login=%, superuser=%, createdb=%, createrole=%, bypassrls=%, replication=%); a superuser must run: ALTER ROLE reporting_audit_retention_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION',
        r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls, r.rolreplication;
    END IF;
  END IF;
END
$$;

GRANT reporting_audit_retention_role TO app_user WITH INHERIT FALSE;
GRANT USAGE ON SCHEMA public TO reporting_audit_retention_role;

GRANT SELECT (id, tenant_id, resource_type, action, created_at), DELETE
  ON admin_audit_log TO reporting_audit_retention_role;

DROP POLICY IF EXISTS "admin_audit_log_reporting_retention_select" ON "admin_audit_log";
CREATE POLICY "admin_audit_log_reporting_retention_select"
  ON "admin_audit_log" FOR SELECT TO reporting_audit_retention_role
  USING (action LIKE 'reporting.%' AND created_at < now() - interval '30 days');

DROP POLICY IF EXISTS "admin_audit_log_reporting_retention_delete" ON "admin_audit_log";
CREATE POLICY "admin_audit_log_reporting_retention_delete"
  ON "admin_audit_log" FOR DELETE TO reporting_audit_retention_role
  USING (action LIKE 'reporting.%' AND created_at < now() - interval '30 days');

DROP POLICY IF EXISTS "admin_audit_log_reporting_retention_bound" ON "admin_audit_log";
CREATE POLICY "admin_audit_log_reporting_retention_bound"
  ON "admin_audit_log" AS RESTRICTIVE FOR ALL TO reporting_audit_retention_role
  USING (action LIKE 'reporting.%' AND created_at < now() - interval '30 days');
