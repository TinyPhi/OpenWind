-- ============================================================
-- Migration: 0128_org_directory_tables
-- docs/specs/org-directory.md T3 -- org-directory tree storage + sync-run tracking
-- ============================================================
--
-- DOWN MIGRATION (rollback):
-- REVOKE SELECT, INSERT, UPDATE, DELETE ON org_directory_sync_runs FROM app_user;
-- REVOKE SELECT, INSERT, UPDATE, DELETE ON org_employees FROM app_user;
-- DROP POLICY IF EXISTS "tenant_write" ON "org_directory_sync_runs";
-- DROP POLICY IF EXISTS "tenant_read" ON "org_directory_sync_runs";
-- ALTER TABLE "org_directory_sync_runs" DISABLE ROW LEVEL SECURITY;
-- DROP INDEX IF EXISTS "org_directory_sync_runs_one_running_per_tenant";
-- DROP INDEX IF EXISTS "org_directory_sync_runs_tenant_idx";
-- DROP TABLE IF EXISTS "org_directory_sync_runs";
-- DROP POLICY IF EXISTS "tenant_write" ON "org_employees";
-- DROP POLICY IF EXISTS "tenant_read" ON "org_employees";
-- ALTER TABLE "org_employees" DISABLE ROW LEVEL SECURITY;
-- DROP INDEX IF EXISTS "org_employees_parent_idx";
-- DROP INDEX IF EXISTS "org_employees_tenant_one_root_unique";
-- DROP INDEX IF EXISTS "org_employees_tenant_user_unique";
-- DROP INDEX IF EXISTS "org_employees_tenant_idx";
-- DROP TABLE IF EXISTS "org_employees";
--
-- analytics: excluded (mirrors external identity-provider PII -- name/email/title;
--   not a platform usage/behavior signal)
--
-- org_employees.user_id is nullable -- NULL denotes the single synthetic root card
-- per tenant (docs/specs/org-directory.md R3), which is not a real employee and has
-- no auth-provider identity. parent_id self-references this table's own surrogate
-- key (not user_id) so tree traversal never needs a join back through user_id, and
-- is left without an explicit ON DELETE action (defaults to NO ACTION/RESTRICT) --
-- app code must reparent a node's children before deleting it (R5, and the
-- per-user-erasure path in user-erasure.ts), never rely on cascade/null-out here.
--
-- org_directory_sync_runs' partial unique index on (tenant_id) WHERE status =
-- 'running' IS the per-tenant sync concurrency lock (R2) -- a second concurrent
-- sync attempt's INSERT of a 'running' row fails on this constraint, so no
-- separate application-level mutex/advisory-lock is needed.

CREATE TABLE "org_employees" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"   uuid NOT NULL REFERENCES tenants(id),
  -- Zitadel JWT sub claim, not a local uuid PK -- matches every other user-reference
  -- column in this schema. NULL only for the synthetic root row (is_root = true).
  "user_id"     text,
  "parent_id"   uuid REFERENCES org_employees(id),
  "name"        text NOT NULL,
  "title"       text NOT NULL DEFAULT '',
  -- Lowercased at sync time (docs/specs/org-directory.md R6); empty string when unset.
  "department"  text NOT NULL DEFAULT '',
  "email"       text NOT NULL DEFAULT '',
  "is_root"     boolean NOT NULL DEFAULT false,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "org_employees_tenant_idx" ON "org_employees" ("tenant_id");
CREATE INDEX "org_employees_parent_idx" ON "org_employees" ("parent_id");

-- One row per (tenant, user) -- only enforced for real employees (user_id NOT NULL);
-- the root row's user_id is NULL and exempt from this constraint.
CREATE UNIQUE INDEX "org_employees_tenant_user_unique"
  ON "org_employees" ("tenant_id", "user_id")
  WHERE "user_id" IS NOT NULL;

-- Exactly one root card per tenant (docs/specs/org-directory.md R3).
CREATE UNIQUE INDEX "org_employees_tenant_one_root_unique"
  ON "org_employees" ("tenant_id")
  WHERE "is_root" = true;

ALTER TABLE "org_employees" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_read" ON "org_employees"
  FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "tenant_write" ON "org_employees"
  FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON org_employees TO app_user';
  END IF;
END
$$;

-- analytics: excluded (operational sync-run bookkeeping, not a usage/behavior signal)

CREATE TABLE "org_directory_sync_runs" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"       uuid NOT NULL REFERENCES tenants(id),
  "status"          text NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'completed', 'failed')),
  "started_at"      timestamptz NOT NULL DEFAULT now(),
  "completed_at"    timestamptz,
  "error"           text,
  "employee_count"  integer,
  "cycles_broken"   integer,
  "reparented"      integer,
  -- Zitadel JWT sub claim of the admin who triggered a manual sync; NULL for the
  -- first-boot auto-seed and the 24h scheduled job (system-triggered, no actor).
  "triggered_by"    text,
  "created_at"      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "org_directory_sync_runs_tenant_idx" ON "org_directory_sync_runs" ("tenant_id");

-- Per-tenant sync concurrency lock (docs/specs/org-directory.md R2) -- see the
-- header comment above.
CREATE UNIQUE INDEX "org_directory_sync_runs_one_running_per_tenant"
  ON "org_directory_sync_runs" ("tenant_id")
  WHERE "status" = 'running';

ALTER TABLE "org_directory_sync_runs" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_read" ON "org_directory_sync_runs"
  FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "tenant_write" ON "org_directory_sync_runs"
  FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON org_directory_sync_runs TO app_user';
  END IF;
END
$$;
