-- ============================================================
-- Migration: 0094_on_call_schedules_table
-- docs/specs/oncall-routing.md T3, R5-R7 -- 3E on-call routing, Phase 1
-- ============================================================
--
-- DOWN MIGRATION (rollback):
-- DROP POLICY IF EXISTS "tenant_write" ON "on_call_schedules";
-- DROP POLICY IF EXISTS "tenant_read" ON "on_call_schedules";
-- ALTER TABLE "on_call_schedules" DISABLE ROW LEVEL SECURITY;
-- DROP INDEX IF EXISTS "on_call_schedules_team_window_idx";
-- DROP INDEX IF EXISTS "on_call_schedules_tenant_idx";
-- DROP TABLE IF EXISTS "on_call_schedules";
-- -- Deliberately NOT dropping the btree_gist extension -- it may be
-- -- depended on by other objects created after this migration; dropping
-- -- extensions in a down-migration is out of scope for this rollback.
--
-- analytics: included (id, tenant_id, team_id, starts_at, ends_at, created_at)
--
-- FIRST use of `EXCLUDE USING gist` / `btree_gist` in this repo (confirmed:
-- `grep -rn "CREATE EXTENSION" packages/db/migrations/` had no hits before
-- this migration). btree_gist is required because the exclusion constraint
-- below mixes an equality operator (=, on tenant_id/team_id, which needs
-- btree's operator class) with a range-overlap operator (&&, on
-- tstzrange) in the same GIST index -- the bare gist extension only
-- provides operator classes for range/geometric types, not scalar
-- equality; btree_gist supplies the missing uuid equality operator class
-- for use inside a GIST index.
--
-- primary_user_id/backup_user_id/escalation_manager_user_id have NO
-- foreign key to a users table here -- same app-layer cross-tenant
-- validation pattern as services.team_id (R1d/T44), since "does this user
-- belong to this tenant" isn't a plain existence check a DB FK can express
-- (users are managed by Zitadel + the tenant_users shadow table, not a
-- users(id) table in this schema).
--
-- team_id has NO foreign key to teams(id) either, for the same reason as
-- services.team_id in migration 0093 -- cross-tenant ownership is an
-- app-layer check (R1d/T44), not a DB constraint.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE "on_call_schedules" (
  "id"                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"                   uuid NOT NULL REFERENCES tenants(id),
  "team_id"                     uuid NOT NULL,
  "label"                       text NOT NULL,
  "starts_at"                   timestamptz NOT NULL,
  "ends_at"                     timestamptz NOT NULL,
  "primary_user_id"             text NOT NULL, -- Zitadel JWT sub claim, not a local uuid PK
  "backup_user_id"              text,
  "escalation_manager_user_id"  text,
  "created_by"                  text NOT NULL,
  "created_at"                  timestamptz NOT NULL DEFAULT now(),
  "updated_at"                  timestamptz NOT NULL DEFAULT now(),
  "deleted_at"                  timestamptz,
  CONSTRAINT "on_call_schedules_window_check" CHECK ("starts_at" < "ends_at"),
  -- R5: overlapping windows for the same (tenant, team) pair are rejected
  -- at the DB layer, not just application-layer -- ADR-016 Decision 2.
  -- Soft-deleted rows (deleted_at IS NOT NULL) are excluded from the
  -- overlap check via the WHERE predicate, matching the spec's soft-delete
  -- semantics (a deleted schedule entry no longer occupies its window).
  CONSTRAINT "on_call_schedules_no_overlap" EXCLUDE USING gist (
    "tenant_id" WITH =,
    "team_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  ) WHERE ("deleted_at" IS NULL)
);

CREATE INDEX "on_call_schedules_tenant_idx" ON "on_call_schedules" ("tenant_id");

-- Primary hot-path query (R6, R8): WHERE team_id = X AND tenant_id = Y AND
-- now() BETWEEN starts_at AND ends_at -- p99 <= 100ms target (spec §C, R8).
CREATE INDEX "on_call_schedules_team_window_idx"
  ON "on_call_schedules" ("tenant_id", "team_id", "starts_at", "ends_at")
  WHERE "deleted_at" IS NULL;

ALTER TABLE "on_call_schedules" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_read" ON "on_call_schedules"
  FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "tenant_write" ON "on_call_schedules"
  FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON on_call_schedules TO app_user';
  END IF;
END
$$;
