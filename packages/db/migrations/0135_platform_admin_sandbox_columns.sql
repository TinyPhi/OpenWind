-- analytics: excluded (adds columns to an existing table — no new table)
--
-- Multi-Org Sandbox System (docs/specs/multi-org-sandbox.md), Phase 1 / T1, T19, T20.
-- ADR-022 (docs/decisions/ADR-022-sandboxing.md) Decision 1: platform_admin's cross-tenant
-- access is enforced by Postgres GRANT on a dedicated role (Option B), not an RLS policy
-- exception -- no RLS policy is added here. `tenants` itself has never carried RLS (it is
-- the tenant registry, not tenant-scoped data), so this migration only needs to create the
-- role and scope its grants to the handful of lifecycle-metadata columns R2 allows.
--
-- DOWN MIGRATION:
--   REVOKE SELECT ON tenants FROM platform_admin_role;
--   REVOKE USAGE ON SCHEMA public FROM platform_admin_role;
--   REVOKE platform_admin_role FROM app_user;
--   DROP ROLE IF EXISTS platform_admin_role;
--   ALTER TABLE tenants DROP COLUMN IF EXISTS created_by_platform_admin;
--   ALTER TABLE tenants DROP COLUMN IF EXISTS trial_ends_at;
--   ALTER TABLE tenants DROP COLUMN IF EXISTS is_sandbox;
--
-- Security review finding (pre-ship): `GRANT platform_admin_role TO app_user` without
-- `WITH INHERIT FALSE` would have given EVERY plain app_user session (i.e. every normal
-- tenant request) automatic, no-SET-ROLE-needed access to platform_admin_role's privileges,
-- via Postgres's default additive role inheritance -- exactly the "a later migration could
-- accidentally widen this without it being visible" failure mode this migration's own
-- comment below says Option B avoids. `WITH INHERIT FALSE` (PG16+; this stack runs 16.13)
-- makes the grant membership-only: app_user can still `SET LOCAL ROLE platform_admin_role`
-- (withPlatformAdminContext does exactly that), but never inherits its privileges passively.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_sandbox BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
-- Zitadel user id of the platform_admin who created this sandbox (R9's completed-action
-- record references the same actor id). NULL for every non-sandbox tenant.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS created_by_platform_admin TEXT;

CREATE INDEX IF NOT EXISTS tenants_is_sandbox_idx ON tenants (is_sandbox) WHERE is_sandbox;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_admin_role') THEN
    CREATE ROLE platform_admin_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- WITH INHERIT FALSE (PG16+): app_user can SET LOCAL ROLE platform_admin_role, but does not
-- passively inherit its privileges on every ordinary tenant-scoped session the way a plain
-- GRANT would (see this file's header comment).
GRANT platform_admin_role TO app_user WITH INHERIT FALSE;

GRANT USAGE ON SCHEMA public TO platform_admin_role;

-- Column-scoped SELECT only, matching the spec's R2 metadata allow-list exactly
-- (name, createdAt, isSandbox, trialStatus derived from trialEndsAt) plus id, which every
-- route needs to address a specific sandbox. No grant on `config`, `plan`, `zitadel_org_id`,
-- `status`, or any other tenants column, and no grant on any other table at all -- this role
-- has zero privileges on business-data tables by construction (Postgres default-deny), not
-- by omission that a later migration could accidentally widen without it being visible here.
GRANT SELECT (id, name, created_at, is_sandbox, trial_ends_at, created_by_platform_admin)
  ON tenants TO platform_admin_role;
