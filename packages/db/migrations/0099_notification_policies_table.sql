-- ============================================================
-- Migration: 0099_notification_policies_table
-- docs/specs/oncall-routing.md T21, R14-R15 -- 3E on-call routing, Phase 1
-- ============================================================
--
-- DOWN MIGRATION (rollback):
-- DROP POLICY IF EXISTS "tenant_write" ON "notification_policies";
-- DROP POLICY IF EXISTS "tenant_read" ON "notification_policies";
-- ALTER TABLE "notification_policies" DISABLE ROW LEVEL SECURITY;
-- DROP INDEX IF EXISTS "notif_policy_team_workflow_severity";
-- DROP INDEX IF EXISTS "notif_policy_workflow_severity";
-- DROP INDEX IF EXISTS "notif_policy_team_severity";
-- DROP INDEX IF EXISTS "notif_policy_global_severity";
-- DROP INDEX IF EXISTS "notification_policies_tenant_idx";
-- DROP TABLE IF EXISTS "notification_policies";
--
-- analytics: included (id, tenant_id, team_id, severity, channels, created_at, deleted_at)
--
-- PR #586 review, B1: `channels` is validated against the canonical channel
-- set from docs/specs/oncall-routing.md R14/R15 (`email`, `sms`, `whatsapp`,
-- `call`) via a DB CHECK, not just non-empty -- an unrecognized channel
-- string must never reach the row, since the notification worker's per-
-- channel dispatch map (docs/oncall-routing-design.md's channel dispatch
-- section) has no fallback for an unknown key and would fail silently or
-- crash at dispatch time, long after the policy was created.
--
-- team_id/workflow_type_id have NO foreign key constraints -- app-layer
-- cross-tenant validation only (R1d/T44, packages/teams' shared
-- validateCrossTenantRefs helper), matching services.team_id's treatment
-- (migration 0093, PR #583 review blocker 1) for consistency across this
-- feature. docs/oncall-routing-design.md's own SQL kept a FK on team_id
-- here (inconsistent with services.team_id, which the design doc itself
-- says should have none) -- deliberately not following that inconsistency;
-- workflow_type_id was already FK-less in the design doc.
--
-- Uniqueness at each specificity level is enforced via four partial
-- indexes, not one composite UNIQUE -- NULL != NULL in Postgres composite
-- uniques makes null-dimension slots ambiguous (ADR-016 Decision 5).

CREATE TABLE "notification_policies" (
  "id"                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"                   uuid NOT NULL REFERENCES tenants(id),
  "team_id"                     uuid,
  "workflow_type_id"            uuid,
  "severity"                    text NOT NULL
                                CHECK ("severity" IN ('critical', 'high', 'medium', 'low')),
  "channels"                    text[] NOT NULL,
  "notify_backup"               boolean NOT NULL DEFAULT true,
  "notify_escalation_manager"   boolean NOT NULL DEFAULT false,
  "created_by"                  text NOT NULL, -- Zitadel JWT sub claim, not a local uuid PK
  "created_at"                  timestamptz NOT NULL DEFAULT now(),
  "updated_at"                  timestamptz NOT NULL DEFAULT now(),
  "deleted_at"                  timestamptz,
  CONSTRAINT "notification_policies_channels_not_empty" CHECK (cardinality("channels") > 0),
  CONSTRAINT "notification_policies_channels_valid"
    CHECK ("channels" <@ ARRAY['email', 'sms', 'whatsapp', 'call']::text[])
);

CREATE INDEX "notification_policies_tenant_idx" ON "notification_policies" ("tenant_id");

-- Soft-deleted policies free their uniqueness slot for a replacement.
CREATE UNIQUE INDEX "notif_policy_global_severity"
  ON "notification_policies" ("tenant_id", "severity")
  WHERE "team_id" IS NULL AND "workflow_type_id" IS NULL AND "deleted_at" IS NULL;

CREATE UNIQUE INDEX "notif_policy_team_severity"
  ON "notification_policies" ("tenant_id", "team_id", "severity")
  WHERE "team_id" IS NOT NULL AND "workflow_type_id" IS NULL AND "deleted_at" IS NULL;

CREATE UNIQUE INDEX "notif_policy_workflow_severity"
  ON "notification_policies" ("tenant_id", "workflow_type_id", "severity")
  WHERE "team_id" IS NULL AND "workflow_type_id" IS NOT NULL AND "deleted_at" IS NULL;

CREATE UNIQUE INDEX "notif_policy_team_workflow_severity"
  ON "notification_policies" ("tenant_id", "team_id", "workflow_type_id", "severity")
  WHERE "team_id" IS NOT NULL AND "workflow_type_id" IS NOT NULL AND "deleted_at" IS NULL;

ALTER TABLE "notification_policies" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_read" ON "notification_policies"
  FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "tenant_write" ON "notification_policies"
  FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON notification_policies TO app_user';
  END IF;
END
$$;
