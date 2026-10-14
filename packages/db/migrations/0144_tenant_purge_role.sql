-- analytics: excluded (role, grants and one RLS policy only -- no new table)
--
-- A narrow role for tenant-purge's privileged pre-steps. tenant-purge.ts ran them on plain
-- `db`, assuming "the worker's privileged connection" -- but the worker connects as app_user,
-- so under compose they failed or silently did nothing:
--   - DELETE schedule_executions: app_user has INSERT+SELECT only (append-only, 0102) -> error.
--   - UPDATE schedule_rules / DELETE saved_views / anonymize admin_audit_log: with no
--     app.tenant_id set, RLS hides every row, so they matched nothing -- the audit log kept
--     real person identifiers after a "completed" purge.
-- CI connects as a superuser, which is why no test noticed (same blind spot as 0143).
--
-- The pre-steps now run through withTenantPurgeContext: SET LOCAL ROLE tenant_purge_role plus
-- app.tenant_id, so the existing tenant RLS policies (all TO public) still confine every
-- statement to the tenant being purged. Same shape as tenant_lifecycle_role (0143): NOLOGIN,
-- NOBYPASSRLS, granted to app_user WITH INHERIT FALSE so an ordinary request never holds these
-- privileges unless it explicitly switches role.
--
-- Also: platform_admin_role may read tenants.status, so the sandbox list can omit deleted
-- sandboxes and a repeat delete can be answered 409 instead of failing in the worker.
--
-- DOWN MIGRATION:
--   REVOKE SELECT (status) ON tenants FROM platform_admin_role;
--   DROP POLICY IF EXISTS "saved_views_tenant_purge_select" ON "saved_views";
--   DROP POLICY IF EXISTS "saved_views_tenant_purge_delete" ON "saved_views";
--   REVOKE SELECT, DELETE ON schedule_executions, saved_views FROM tenant_purge_role;
--   REVOKE SELECT, UPDATE (status) ON schedule_rules FROM tenant_purge_role;
--   REVOKE SELECT ON tenant_users FROM tenant_purge_role;
--   REVOKE SELECT, UPDATE (actor_id, acting_person_id, metadata, before_snapshot,
--     after_snapshot) ON admin_audit_log FROM tenant_purge_role;
--   REVOKE USAGE ON SCHEMA public FROM tenant_purge_role;
--   REVOKE tenant_purge_role FROM app_user;
--   DROP ROLE IF EXISTS tenant_purge_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_purge_role') THEN
    CREATE ROLE tenant_purge_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT tenant_purge_role TO app_user WITH INHERIT FALSE;
GRANT USAGE ON SCHEMA public TO tenant_purge_role;

-- Archive the tenant's schedule rules (so the tick can't add executions mid-purge), then
-- delete the append-only executions.
GRANT SELECT, UPDATE (status) ON schedule_rules TO tenant_purge_role;
GRANT SELECT, DELETE ON schedule_executions TO tenant_purge_role;

-- saved_views' policy also requires user_id = app.user_id, which a tenant-wide purge has no
-- single value for. These policies let only tenant_purge_role read and delete the current
-- tenant's rows -- scoped to SELECT and DELETE, so a later INSERT/UPDATE grant to this role
-- could not use them to skip the user_id check.
GRANT SELECT, DELETE ON saved_views TO tenant_purge_role;
DROP POLICY IF EXISTS "saved_views_tenant_purge_select" ON "saved_views";
CREATE POLICY "saved_views_tenant_purge_select"
  ON "saved_views"
  FOR SELECT
  TO tenant_purge_role
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
DROP POLICY IF EXISTS "saved_views_tenant_purge_delete" ON "saved_views";
CREATE POLICY "saved_views_tenant_purge_delete"
  ON "saved_views"
  FOR DELETE
  TO tenant_purge_role
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Audit-log anonymization (spec R9): reads the tenant's members to find person ids, then
-- rewrites only the person-identifying columns. action, resource_type, resource_id and
-- created_at stay out of reach, so the operational history can't be altered.
GRANT SELECT ON tenant_users TO tenant_purge_role;
GRANT SELECT,
  UPDATE (actor_id, acting_person_id, metadata, before_snapshot, after_snapshot)
  ON admin_audit_log TO tenant_purge_role;

GRANT SELECT (status) ON tenants TO platform_admin_role;
