-- ============================================================
-- Migration: 0092_teams_table
-- docs/specs/oncall-routing.md T1, R3 -- 3E on-call routing, Phase 1
-- ============================================================
--
-- DOWN MIGRATION (rollback):
-- DROP POLICY IF EXISTS "tenant_write" ON "teams";
-- DROP POLICY IF EXISTS "tenant_read" ON "teams";
-- ALTER TABLE "teams" DISABLE ROW LEVEL SECURITY;
-- DROP INDEX IF EXISTS "teams_tenant_name_unique";
-- DROP INDEX IF EXISTS "teams_tenant_idx";
-- DROP TABLE IF EXISTS "teams";
--
-- analytics: included (id, tenant_id, name, created_at)
--
-- created_by NOT NULL (PR #583 review, G1): every other admin-managed
-- resource in the platform (entity_instances, view_configs, saved_views,
-- and this same feature's on_call_schedules) records who created it --
-- teams/services were the odd ones out. Lets "all teams created by this
-- admin" be queried directly without going through the audit log.

CREATE TABLE "teams" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"   uuid NOT NULL REFERENCES tenants(id),
  "name"        text NOT NULL,
  "description" text,
  "created_by"  text NOT NULL, -- Zitadel JWT sub claim, not a local uuid PK
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  "deleted_at"  timestamptz
);

CREATE INDEX "teams_tenant_idx" ON "teams" ("tenant_id");

-- Soft-deleted rows free their name for reuse (R3: duplicate name within a
-- tenant returns 409 -- enforced only against still-live rows).
CREATE UNIQUE INDEX "teams_tenant_name_unique"
  ON "teams" ("tenant_id", "name")
  WHERE "deleted_at" IS NULL;

ALTER TABLE "teams" ENABLE ROW LEVEL SECURITY;

-- nullif-guarded per the fix in migration 0090 -- current_setting(...) can
-- return '' (not NULL) on a connection where app.tenant_id was previously
-- set and later reset; bare ''::uuid casts throw instead of filtering.
CREATE POLICY "tenant_read" ON "teams"
  FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "tenant_write" ON "teams"
  FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON teams TO app_user';
  END IF;
END
$$;
