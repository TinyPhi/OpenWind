-- ============================================================
-- Migration: 0157_team_members_table
-- docs/specs/oncall-team-rotation.md T1, R1 -- ADR-016 addendum A1
-- ============================================================
--
-- DOWN MIGRATION (rollback):
-- DROP POLICY IF EXISTS "tenant_write" ON "team_members";
-- DROP POLICY IF EXISTS "tenant_read" ON "team_members";
-- ALTER TABLE "team_members" DISABLE ROW LEVEL SECURITY;
-- DROP INDEX IF EXISTS "team_members_team_position_unique";
-- DROP INDEX IF EXISTS "team_members_team_user_unique";
-- DROP INDEX IF EXISTS "team_members_tenant_user_idx";
-- DROP INDEX IF EXISTS "team_members_tenant_idx";
-- DROP TABLE IF EXISTS "team_members";
--
-- analytics: excluded (membership of a team is a user reference with no reporting value)
--
-- user_id is a Zitadel sub with no local users table, so it carries no FK; the
-- API validates it against the tenant before every write. Membership is not
-- history: rows are hard-deleted (member removed, user erased, team purged).
-- position gives the rotation order and is kept contiguous from 0: every
-- removal or replace re-numbers the team (compactTeamPositions in
-- @platform/teams), so the rotation never steps over a gap.

CREATE TABLE "team_members" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"  uuid NOT NULL REFERENCES tenants(id),
  "team_id"    uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  "user_id"    text NOT NULL, -- Zitadel JWT sub claim, not a local uuid PK
  "position"   integer NOT NULL CHECK ("position" >= 0),
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "team_members_tenant_idx" ON "team_members" ("tenant_id");

-- Erasure deletes every row for one user in a tenant.
CREATE INDEX "team_members_tenant_user_idx" ON "team_members" ("tenant_id", "user_id");

CREATE UNIQUE INDEX "team_members_team_user_unique"
  ON "team_members" ("team_id", "user_id");

CREATE UNIQUE INDEX "team_members_team_position_unique"
  ON "team_members" ("team_id", "position");

ALTER TABLE "team_members" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_read" ON "team_members"
  FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "tenant_write" ON "team_members"
  FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON team_members TO app_user';
  END IF;
END
$$;
