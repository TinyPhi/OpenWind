-- ============================================================
-- Migration: 0102_schedule_executions_table
-- docs/specs/temporal-scheduler.md T2, R5-R9 -- 3F temporal scheduler, Phase 1
-- ============================================================
--
-- DOWN MIGRATION (rollback):
-- DROP POLICY IF EXISTS "schedule_executions_tenant_rls" ON "schedule_executions";
-- ALTER TABLE "schedule_executions" DISABLE ROW LEVEL SECURITY;
-- DROP INDEX IF EXISTS "schedule_executions_tenant_idx";
-- DROP INDEX IF EXISTS "schedule_executions_rule_idx";
-- DROP TABLE IF EXISTS "schedule_executions";
--
-- analytics: included(id, tenant_id, rule_id, scheduled_at, status, created_at)
--
-- Append-only -- no soft-delete column, no UPDATE/DELETE grant to app_user
-- (see §V: "Execution log is append-only -- schedule_executions rows are
-- never updated or deleted"), same invariant shape as admin_audit_log.

CREATE TABLE "schedule_executions" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"           uuid NOT NULL REFERENCES tenants(id),
  -- PR #586 review, S2: RESTRICT (not CASCADE/SET NULL) is deliberate --
  -- schedule_rules are soft-deleted only (migration 0101's deleted_at), so
  -- this FK is never expected to face an actual row deletion. If a future
  -- hard-delete/cleanup path for schedule_rules is added, it must account
  -- for this FK blocking it rather than silently switching the constraint.
  "rule_id"             uuid NOT NULL REFERENCES schedule_rules(id) ON DELETE RESTRICT,
  "scheduled_at"        timestamptz NOT NULL,
  "fired_at"            timestamptz NOT NULL DEFAULT now(),
  "status"              text NOT NULL CHECK ("status" IN ('success', 'failed', 'skipped')),
  "entity_instance_id"  uuid REFERENCES entity_instances(id),
  "error_code"          text,
  "created_at"          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "schedule_executions_rule_idx"
  ON "schedule_executions" ("rule_id", "scheduled_at" DESC);
CREATE INDEX "schedule_executions_tenant_idx"
  ON "schedule_executions" ("tenant_id", "created_at" DESC);

ALTER TABLE "schedule_executions" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "schedule_executions_tenant_rls" ON "schedule_executions"
  FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    -- INSERT + SELECT only -- append-only, matches admin_audit_log's grant
    -- shape (migration 0011). No UPDATE/DELETE.
    EXECUTE 'GRANT SELECT, INSERT ON schedule_executions TO app_user';
  END IF;
END
$$;
