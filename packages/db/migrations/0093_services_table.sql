-- ============================================================
-- Migration: 0093_services_table
-- docs/specs/oncall-routing.md T2, R4 -- 3E on-call routing, Phase 1
-- ============================================================
--
-- DOWN MIGRATION (rollback):
-- DROP POLICY IF EXISTS "tenant_write" ON "services";
-- DROP POLICY IF EXISTS "tenant_read" ON "services";
-- ALTER TABLE "services" DISABLE ROW LEVEL SECURITY;
-- DROP INDEX IF EXISTS "services_tenant_name_unique";
-- DROP INDEX IF EXISTS "services_team_idx";
-- DROP INDEX IF EXISTS "services_tenant_idx";
-- DROP TABLE IF EXISTS "services";
--
-- analytics: included (id, tenant_id, name, team_id, created_at)
--
-- team_id has NO foreign key constraint to teams(id) here -- cross-tenant
-- ownership of team_id is validated at the application layer (R1d/T44,
-- packages/teams' shared validateCrossTenantRefs helper), not via a DB FK,
-- because a plain FK would only guarantee the team exists somewhere, not
-- that it belongs to the same tenant as this service (Postgres FK checks
-- bypass RLS -- see docs/specs/oncall-routing.md's "cross-tenant FK" row
-- in §C). ON DELETE RESTRICT is still meaningful once the app-layer check
-- passes: it blocks hard-deleting a team row while services still
-- reference it (teams are soft-deleted in practice -- R3 -- so this is a
-- defense-in-depth backstop, not the primary deletion guard).

CREATE TABLE "services" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"   uuid NOT NULL REFERENCES tenants(id),
  "name"        text NOT NULL,
  "description" text,
  "team_id"     uuid REFERENCES teams(id) ON DELETE RESTRICT,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  "deleted_at"  timestamptz
);

CREATE INDEX "services_tenant_idx" ON "services" ("tenant_id");
CREATE INDEX "services_team_idx" ON "services" ("team_id");

CREATE UNIQUE INDEX "services_tenant_name_unique"
  ON "services" ("tenant_id", "name")
  WHERE "deleted_at" IS NULL;

ALTER TABLE "services" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_read" ON "services"
  FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "tenant_write" ON "services"
  FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON services TO app_user';
  END IF;
END
$$;
