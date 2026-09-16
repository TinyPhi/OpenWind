-- ============================================================
-- Migration: 0101_schedule_rules_table
-- docs/specs/temporal-scheduler.md T1, R1 -- 3F temporal scheduler, Phase 1
-- ============================================================
--
-- DOWN MIGRATION (rollback):
-- DROP POLICY IF EXISTS "schedule_rules_tenant_rls" ON "schedule_rules";
-- ALTER TABLE "schedule_rules" DISABLE ROW LEVEL SECURITY;
-- DROP INDEX IF EXISTS "schedule_rules_tenant_idx";
-- DROP INDEX IF EXISTS "schedule_rules_due_idx";
-- DROP INDEX IF EXISTS "schedule_rules_name_tenant_unique";
-- DROP TABLE IF EXISTS "schedule_rules";
--
-- analytics: included(id, tenant_id, name, status, next_fire_at, created_at, deleted_at)
--
-- entity_type_id / workflow_id keep a real FK (existence guarantee) PLUS an
-- app-layer tenant-ownership check on POST/PATCH (FK validation bypasses
-- RLS, so the FK alone can't confirm the row belongs to the requesting
-- tenant) -- docs/temporal-scheduler-design.md §1.1's own documented
-- pattern. template's team_id/assignee_id/service_id (validated per §1.3)
-- live inside the template JSONB column, not as separate columns -- a JSONB
-- value can't carry a FK at all, so those three are purely app-layer
-- validated (R10b, reusing packages/teams' shared validateCrossTenantRefs
-- helper) at the route layer in Phase 2 -- this table is not an
-- entity-engine entity type, so the ticket-fields entity_ref gap
-- (open-questions.md) does not apply here.
--
-- PR #586 review, B2: `cron_expr` has no full syntax validation at the DB
-- layer -- the Phase 2 route layer validates it with `cron-parser`
-- (docs/temporal-scheduler-design.md §"Validated via cron-parser before
-- storage; invalid expressions never reach DB") before insert/update, which
-- is where full 5-field semantic validation belongs (a complete cron parser
-- in SQL is impractical). This CHECK is a cheap DB-layer backstop that
-- rejects the single most common malformed shape (wrong field count) even
-- if a future write path bypasses the route-layer Zod/cron-parser check.

CREATE TABLE "schedule_rules" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"       uuid NOT NULL REFERENCES tenants(id),
  "name"            text NOT NULL,
  "description"     text,

  "cron_expr"       text NOT NULL,
  "timezone"        text NOT NULL DEFAULT 'UTC',

  -- PR #586 review, G1: this FK only guarantees the entity_type row exists
  -- globally (entity_types is platform-wide, not tenant-scoped) -- it does
  -- NOT guarantee the requesting tenant has the owning module provisioned.
  -- Phase 2's route layer must additionally check tenant-module access
  -- before accepting this reference (tracked in #593).
  "entity_type_id"  uuid NOT NULL REFERENCES entity_types(id),
  "workflow_id"     uuid REFERENCES workflows(id) ON DELETE RESTRICT,
  "template"        jsonb NOT NULL,

  "status"          text NOT NULL DEFAULT 'active'
                    CHECK ("status" IN ('active', 'paused', 'archived')),
  "next_fire_at"    timestamptz,
  "last_fired_at"   timestamptz,
  "catch_up"        boolean NOT NULL DEFAULT false,

  "created_by"      text NOT NULL, -- Zitadel JWT sub claim, not a local uuid PK
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now(),
  "deleted_at"      timestamptz,

  CONSTRAINT "schedule_rules_cron_expr_five_fields"
    CHECK (cardinality(string_to_array(trim("cron_expr"), ' ')) = 5),
  -- PR #586 review, G2: catches the most common template error (missing
  -- `title`) before the worker tries to create a ticket from it -- full
  -- structural validation of the template happens at the route layer (Zod,
  -- docs/temporal-scheduler-design.md's template schema).
  CONSTRAINT "schedule_rules_template_has_title"
    CHECK (jsonb_typeof("template") = 'object' AND ("template" ? 'title'))
);

CREATE UNIQUE INDEX "schedule_rules_name_tenant_unique"
  ON "schedule_rules" ("tenant_id", "name") WHERE "deleted_at" IS NULL;

-- Hot-path index: worker polls WHERE status='active' AND next_fire_at <= now().
CREATE INDEX "schedule_rules_due_idx"
  ON "schedule_rules" ("next_fire_at") WHERE "status" = 'active' AND "deleted_at" IS NULL;

CREATE INDEX "schedule_rules_tenant_idx"
  ON "schedule_rules" ("tenant_id") WHERE "deleted_at" IS NULL;

ALTER TABLE "schedule_rules" ENABLE ROW LEVEL SECURITY;

-- Single FOR ALL policy (covers SELECT too -- PostgreSQL ORs permissive
-- policies for the same command, so a separate FOR SELECT policy would be
-- redundant), per the design doc's own note.
CREATE POLICY "schedule_rules_tenant_rls" ON "schedule_rules"
  FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON schedule_rules TO app_user';
  END IF;
END
$$;
