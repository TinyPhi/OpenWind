-- analytics: excluded (role and grants only -- no new table)
--
-- A narrow role for the few code paths that create tenants or change their lifecycle status.
-- Migrations 0061/0062 (issues #404-#408) deliberately revoked INSERT, DELETE and table-wide
-- UPDATE on `tenants` from app_user, leaving SELECT and UPDATE (config, updated_at). But the
-- API and worker connect as app_user, and tenant provisioning (API and sandbox), suspend /
-- restore / schedule-deletion, the sandbox delete flip and tenant-purge's "purged" flip all
-- still wrote `tenants` on that connection -- so under app_user every one of them failed.
-- CI connects as a superuser, which is why no test noticed.
--
-- Rather than undo #404-#408 for every app_user session, those writes now SET LOCAL ROLE
-- tenant_lifecycle_role (packages/db withTenantLifecycleContext). Same shape as
-- platform_admin_role (0135): NOLOGIN, NOBYPASSRLS, granted to app_user WITH INHERIT FALSE so
-- an ordinary request never holds these privileges unless it explicitly switches role.
--
-- DOWN MIGRATION:
--   REVOKE SELECT, INSERT, DELETE ON tenants FROM tenant_lifecycle_role;
--   REVOKE UPDATE (status, suspended_at, deletion_scheduled_at, updated_at) ON tenants
--     FROM tenant_lifecycle_role;
--   REVOKE USAGE ON SCHEMA public FROM tenant_lifecycle_role;
--   REVOKE tenant_lifecycle_role FROM app_user;
--   DROP ROLE IF EXISTS tenant_lifecycle_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_lifecycle_role') THEN
    CREATE ROLE tenant_lifecycle_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT tenant_lifecycle_role TO app_user WITH INHERIT FALSE;

GRANT USAGE ON SCHEMA public TO tenant_lifecycle_role;

-- SELECT for INSERT ... RETURNING and the WHERE clauses of the status updates. INSERT for
-- provisioning; DELETE only for the sandbox provisioning rollback (T11) of a tenant row it
-- just created. UPDATE is column-scoped to lifecycle state: name, plan, slug, config,
-- zitadel_org_id and the sandbox columns stay out of reach of this role.
GRANT SELECT, INSERT, DELETE ON tenants TO tenant_lifecycle_role;
GRANT UPDATE (status, suspended_at, deletion_scheduled_at, updated_at)
  ON tenants TO tenant_lifecycle_role;
