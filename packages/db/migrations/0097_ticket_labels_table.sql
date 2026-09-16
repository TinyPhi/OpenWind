-- ============================================================
-- Migration: 0097_ticket_labels_table
-- docs/specs/oncall-routing.md T35, R1c -- 3E on-call routing, Phase 1
-- ============================================================
--
-- DOWN MIGRATION (rollback):
-- DROP POLICY IF EXISTS "tenant_write" ON "ticket_labels";
-- DROP POLICY IF EXISTS "tenant_read" ON "ticket_labels";
-- ALTER TABLE "ticket_labels" DISABLE ROW LEVEL SECURITY;
-- DROP INDEX IF EXISTS "ticket_labels_label_idx";
-- DROP INDEX IF EXISTS "ticket_labels_tenant_idx";
-- DROP TABLE IF EXISTS "ticket_labels";
--
-- analytics: included (ticket_instance_id, label_id, tenant_id, assigned_at)
--
-- Junction table -- composite PK (ticket_instance_id, label_id), NOT the
-- surrogate-id + soft-delete shape entity_relations uses, per the spec's
-- explicit invariant (§V): "ticket_labels rows are hard-deleted only on
-- explicit label removal" -- assignment HISTORY is preserved via the audit
-- log's label.removed entries (see migration 0098), not via a deleted_at
-- column on this table itself. tenant_id is denormalized (not derived via
-- a join to entity_instances) so RLS can filter directly on this table,
-- matching the same pattern the spec calls out for this exact reason.
--
-- label_id has NO foreign key to labels(id) -- cross-tenant ownership is
-- validated at the application layer (R1d/T44, packages/teams' shared
-- validateCrossTenantRefs helper), same reasoning as services.team_id
-- (migration 0093) and on_call_schedules' user columns (migration 0094).
-- ticket_instance_id DOES have a FK to entity_instances(id) -- that table
-- IS the tenant-scoped entity store the entity engine already guards via
-- its own existing validation path, unlike labels/teams/services.--
-- PR #585 review, S1: the composite PK (ticket_instance_id, label_id) does
-- not itself guarantee tenant_id matches ticket_instance_id's real tenant --
-- there is no DB-layer guard for that beyond the RLS policies below (which
-- only check this row's own tenant_id against the session GUC). The
-- app-layer INSERT path is responsible for deriving tenant_id from the
-- ticket, never accepting it as a separate caller-supplied value.

CREATE TABLE "ticket_labels" (
  "ticket_instance_id"  uuid NOT NULL REFERENCES entity_instances(id),
  "label_id"            uuid NOT NULL,
  "tenant_id"           uuid NOT NULL REFERENCES tenants(id),
  "assigned_by"         text NOT NULL, -- Zitadel JWT sub claim, not a local uuid PK
  "assigned_at"         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("ticket_instance_id", "label_id")
);

CREATE INDEX "ticket_labels_tenant_idx" ON "ticket_labels" ("tenant_id");
-- Supports "GET /tickets?label_id=X" (R1c) -- filter tickets by label.
CREATE INDEX "ticket_labels_label_idx" ON "ticket_labels" ("tenant_id", "label_id");

ALTER TABLE "ticket_labels" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_read" ON "ticket_labels"
  FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "tenant_write" ON "ticket_labels"
  FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_labels TO app_user';
  END IF;
END
$$;
