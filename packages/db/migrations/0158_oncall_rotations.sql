-- ============================================================
-- Migration: 0158_oncall_rotations
-- docs/specs/oncall-team-rotation.md T7, R4-R6, R8, R10 -- ADR-016 addendum A2-A4
-- ============================================================
--
-- DOWN MIGRATION (rollback):
-- REVOKE SELECT (id, tenant_id, team_id, status, next_starts_at, ends_on) ON on_call_rotations FROM oncall_rotation_sweeper;
-- REVOKE USAGE ON SCHEMA public FROM oncall_rotation_sweeper;
-- REVOKE oncall_rotation_sweeper FROM app_user;
-- DROP ROLE IF EXISTS oncall_rotation_sweeper;
-- ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
-- ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN ('entity.assigned', 'comment.mentioned', 'comment.mention_access_granted', 'comment.replied', 'access.granted', 'access.revoked', 'workflow.sla_breached', 'system.error', 'automation.notify', 'ticket.alert', 'access.updated', 'workflow.transitioned', 'entity.updated', 'entity.due_date_approaching', 'access_request.created', 'access_request.updated', 'entity.unassigned', 'oncall.backup_tagged', 'ticket.severity_notification'));
--
-- DROP INDEX IF EXISTS "team_members_tenant_user_unique";
-- CREATE INDEX "team_members_tenant_user_idx" ON "team_members" ("tenant_id", "user_id");
--
-- DROP POLICY IF EXISTS "tenant_write" ON "on_call_schedule_notices";
-- DROP POLICY IF EXISTS "tenant_read" ON "on_call_schedule_notices";
-- ALTER TABLE "on_call_schedule_notices" DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS "on_call_schedule_notices";
-- DROP INDEX IF EXISTS "on_call_schedules_rotation_start_unique";
-- ALTER TABLE "on_call_schedules" DROP COLUMN IF EXISTS "rotation_id";
-- DROP POLICY IF EXISTS "tenant_write" ON "on_call_rotations";
-- DROP POLICY IF EXISTS "tenant_read" ON "on_call_rotations";
-- ALTER TABLE "on_call_rotations" DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS "on_call_rotations";
--
-- analytics: excluded (on_call_rotations: scheduling cursor with user references, no reporting value)
-- analytics: excluded (on_call_schedule_notices: delivery bookkeeping with user references)
--
-- A rotation is the recurring-roster definition for one team. Its cursor (next_starts_at plus the
-- last assignment) is where generation continues when no generated window still exists. Status is
-- 'active' or 'stopped'; "blocked" is an active rotation with blocked_reason set (a manual window
-- overlaps the one it would create). A deleted window is never regenerated: next_starts_at has
-- already moved past it, and the unique (rotation_id, starts_at) index below also covers a
-- soft-deleted row.
--
-- user ids are Zitadel subs with no local users table, so no FK; the API validates them.

CREATE TABLE "on_call_rotations" (
  "id"                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"                  uuid NOT NULL REFERENCES tenants(id),
  "team_id"                    uuid NOT NULL REFERENCES teams(id),
  "cycle_days"                 integer NOT NULL CHECK ("cycle_days" BETWEEN 3 AND 90),
  "status"                     text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'stopped')),
  "ends_on"                    date,
  "blocked_reason"             text,
  "next_starts_at"             timestamptz NOT NULL,
  "last_primary_user_id"       text NOT NULL,
  "last_backup_user_id"        text,
  "escalation_manager_user_id" text,
  "created_by"                 text NOT NULL,
  "created_at"                 timestamptz NOT NULL DEFAULT now(),
  "updated_at"                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "on_call_rotations_tenant_idx" ON "on_call_rotations" ("tenant_id");
CREATE INDEX "on_call_rotations_tenant_team_idx" ON "on_call_rotations" ("tenant_id", "team_id");

-- The worker's cross-tenant poll: active rotations by when their next window is due.
CREATE INDEX "on_call_rotations_due_idx" ON "on_call_rotations" ("next_starts_at")
  WHERE "status" = 'active';

-- At most one active rotation per team (R4).
CREATE UNIQUE INDEX "on_call_rotations_one_active_per_team"
  ON "on_call_rotations" ("tenant_id", "team_id")
  WHERE "status" = 'active';

ALTER TABLE "on_call_rotations" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_read" ON "on_call_rotations"
  FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "tenant_write" ON "on_call_rotations"
  FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- A generated window carries its rotation. The unique index makes generating a window exactly-once
-- even with several worker instances or a rolling deploy.
ALTER TABLE "on_call_schedules"
  ADD COLUMN "rotation_id" uuid REFERENCES on_call_rotations(id);

CREATE UNIQUE INDEX "on_call_schedules_rotation_start_unique"
  ON "on_call_schedules" ("rotation_id", "starts_at")
  WHERE "rotation_id" IS NOT NULL;

-- Exactly-once guard for the advance notice (R8): one row per (window, person, role).
CREATE TABLE "on_call_schedule_notices" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"   uuid NOT NULL REFERENCES tenants(id),
  "schedule_id" uuid NOT NULL REFERENCES on_call_schedules(id), -- no cascade: delete a window's notices before the window
  "user_id"     text NOT NULL,
  "role"        text NOT NULL CHECK ("role" IN ('primary', 'backup', 'escalation_manager')),
  "sent_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "on_call_schedule_notices_tenant_idx" ON "on_call_schedule_notices" ("tenant_id");
CREATE INDEX "on_call_schedule_notices_tenant_user_idx" ON "on_call_schedule_notices" ("tenant_id", "user_id");

CREATE UNIQUE INDEX "on_call_schedule_notices_once"
  ON "on_call_schedule_notices" ("schedule_id", "user_id", "role");

ALTER TABLE "on_call_schedule_notices" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_read" ON "on_call_schedule_notices"
  FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "tenant_write" ON "on_call_schedule_notices"
  FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON on_call_rotations TO app_user';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON on_call_schedule_notices TO app_user';
  END IF;
END
$$;

-- The rotation worker's cross-tenant discovery (same shape as 0107's schedule_sweeper, narrower):
-- RLS hides rotations from a worker with no tenant context, so it polls through this BYPASSRLS
-- role. It may only READ the six columns it needs to find due rotations. It gets no UPDATE: the
-- worker re-locks each rotation and creates the window, advances the cursor and records notices
-- inside an ordinary tenant-scoped transaction (app_user + app.tenant_id), where RLS applies.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oncall_rotation_sweeper') THEN
    CREATE ROLE oncall_rotation_sweeper NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
  END IF;
END
$$;

GRANT oncall_rotation_sweeper TO app_user;
GRANT USAGE ON SCHEMA public TO oncall_rotation_sweeper;
GRANT SELECT (id, tenant_id, team_id, status, next_starts_at, ends_on)
  ON on_call_rotations TO oncall_rotation_sweeper;

-- The advance notice is an ordinary in-app notification; notifications.type is a CHECK enum,
-- and a mocked-DB unit test cannot see it (see 0104's comment), so the new type is added here.
-- Re-lists every value from 0105_notifications_severity_channel.sql, the constraint this builds on.
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'entity.assigned',
  'comment.mentioned',
  'comment.mention_access_granted',
  'comment.replied',
  'access.granted',
  'access.revoked',
  'workflow.sla_breached',
  'system.error',
  'automation.notify',
  'ticket.alert',
  'access.updated',
  'workflow.transitioned',
  'entity.updated',
  'entity.due_date_approaching',
  'access_request.created',
  'access_request.updated',
  'entity.unassigned',
  'oncall.backup_tagged',
  'ticket.severity_notification',
  'oncall.rotation_notice'
));

-- One team per person (R3). The API refuses a second membership with a friendly message, but that
-- check and the write are separate transactions, so two admins saving at once could both pass it. The
-- rotation picks the next member by team order, so a person on two teams would be assigned twice.
-- This unique index also serves the erasure lookup the old (tenant_id, user_id) index existed for.
-- Fail with a clear message rather than the bare duplicate-key error if a deployment already has
-- someone on two teams: which team they stay on is the admin's call, not the migration's.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM team_members GROUP BY tenant_id, user_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'team_members has a person on more than one team; remove the extra memberships (PUT /admin/teams/:id/members) and rerun this migration';
  END IF;
END $$;

DROP INDEX "team_members_tenant_user_idx";
CREATE UNIQUE INDEX "team_members_tenant_user_unique"
  ON "team_members" ("tenant_id", "user_id");
