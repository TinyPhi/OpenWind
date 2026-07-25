-- Down migration:
-- DROP POLICY IF EXISTS tenant_type_read  ON entity_types;
-- DROP POLICY IF EXISTS tenant_type_write ON entity_types;
-- ALTER TABLE entity_types DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_workflow_read  ON workflows;
-- DROP POLICY IF EXISTS tenant_workflow_write ON workflows;
-- ALTER TABLE workflows DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_read  ON workflow_states;
-- DROP POLICY IF EXISTS tenant_write ON workflow_states;
-- ALTER TABLE workflow_states DISABLE ROW LEVEL SECURITY;
-- DROP INDEX IF EXISTS workflow_states_tenant_idx;
-- ALTER TABLE workflow_states DROP COLUMN tenant_id;
--
-- DROP POLICY IF EXISTS tenant_read  ON workflow_transitions;
-- DROP POLICY IF EXISTS tenant_write ON workflow_transitions;
-- ALTER TABLE workflow_transitions DISABLE ROW LEVEL SECURITY;
-- DROP INDEX IF EXISTS workflow_transitions_tenant_idx;
-- ALTER TABLE workflow_transitions DROP COLUMN tenant_id;

-- ADR-007: RLS for entity_types / workflows / workflow_states / workflow_transitions.
-- See docs/decisions/ADR-007-rls-workflow-config-tables.md for the full decision record,
-- evaluated alternatives, and verification that no legitimate cross-tenant path breaks
-- (module install via executeRawInTenantContext, tenant-purge.ts's withTenantContext-scoped
-- deletes, and the entity_fields-shape precedent already live since migration 0001).

-- ── 1. entity_types: entity_fields-style nullable-tenant policy pair ────────────
-- analytics: excluded (RLS/policy only — no new table)

ALTER TABLE entity_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_type_read ON entity_types
  FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = current_setting('app.tenant_id', true)::UUID);

CREATE POLICY tenant_type_write ON entity_types
  FOR ALL
  USING      (tenant_id = current_setting('app.tenant_id', true)::UUID)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::UUID);

-- ── 2. workflows: same shape ─────────────────────────────────────────────────────

ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_workflow_read ON workflows
  FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = current_setting('app.tenant_id', true)::UUID);

CREATE POLICY tenant_workflow_write ON workflows
  FOR ALL
  USING      (tenant_id = current_setting('app.tenant_id', true)::UUID)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::UUID);

-- ── 3. workflow_states: denormalized tenant_id (NOT NULL), entity_instances shape ──
-- No NULL-tenant shape needed here: a workflow's tenant_id is never NULL
-- (createWorkflow requires a concrete tenantId; see ADR-007 "Evaluated Options").
-- Dev row counts are trivial (22 rows) — see ADR-007 "Backfill safety" for the
-- precedent (0024_entity_instances_search_vector.sql) this follows if that's
-- not true at production scale.
--
-- Plain ADD COLUMN + SET NOT NULL, not the NOT VALID/VALIDATE CONSTRAINT
-- low-lock pattern: this repo's migration runner
-- (drizzle-orm/postgres-js/migrator, see PgDialect.migrate) wraps every
-- pending migration into ONE session.transaction(...) call, so the ACCESS
-- EXCLUSIVE lock from ADD COLUMN below is already held for the rest of this
-- transaction regardless — VALIDATE CONSTRAINT's weaker SHARE UPDATE
-- EXCLUSIVE requirement buys nothing once a stronger lock is already in
-- hand, and the extra constraint create/drop only adds work under that same
-- held lock. Found via adversarial review; an earlier draft of this
-- migration used the low-lock pattern based on general Postgres practice
-- without checking it against this specific migration runner.
ALTER TABLE workflow_states ADD COLUMN tenant_id UUID;

UPDATE workflow_states ws SET tenant_id = w.tenant_id
  FROM workflows w WHERE w.id = ws.workflow_id;

ALTER TABLE workflow_states ALTER COLUMN tenant_id SET NOT NULL;

CREATE INDEX workflow_states_tenant_idx ON workflow_states (tenant_id);
ALTER TABLE workflow_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_read ON workflow_states
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID);

CREATE POLICY tenant_write ON workflow_states
  FOR ALL
  USING      (tenant_id = current_setting('app.tenant_id', true)::UUID)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::UUID);

-- ── 4. workflow_transitions: same treatment as workflow_states ──────────────────

ALTER TABLE workflow_transitions ADD COLUMN tenant_id UUID;

UPDATE workflow_transitions wt SET tenant_id = w.tenant_id
  FROM workflows w WHERE w.id = wt.workflow_id;

ALTER TABLE workflow_transitions ALTER COLUMN tenant_id SET NOT NULL;

CREATE INDEX workflow_transitions_tenant_idx ON workflow_transitions (tenant_id);
ALTER TABLE workflow_transitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_read ON workflow_transitions
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID);

CREATE POLICY tenant_write ON workflow_transitions
  FOR ALL
  USING      (tenant_id = current_setting('app.tenant_id', true)::UUID)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::UUID);
