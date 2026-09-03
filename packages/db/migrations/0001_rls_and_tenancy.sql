-- ============================================================
-- Migration: 0001_rls_and_tenancy
-- Adds RLS policies to all tenant-scoped tables, adds
-- tenant.status lifecycle column, api_keys table, and
-- tenant_id to workflow_events.
-- ============================================================
--
-- DOWN MIGRATION (rollback):
--
-- ALTER TABLE workflow_events DROP COLUMN tenant_id;
-- ALTER TABLE tenants DROP COLUMN status;
-- DROP TABLE api_keys;
--
-- DROP POLICY tenant_read  ON entity_instances;
-- DROP POLICY tenant_write ON entity_instances;
-- ALTER TABLE entity_instances DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY tenant_read  ON entity_relations;
-- DROP POLICY tenant_write ON entity_relations;
-- ALTER TABLE entity_relations DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY tenant_field_read  ON entity_fields;
-- DROP POLICY tenant_field_write ON entity_fields;
-- ALTER TABLE entity_fields DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY tenant_read  ON workflow_events;
-- DROP POLICY tenant_write ON workflow_events;
-- ALTER TABLE workflow_events DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY tenant_read  ON automation_rules;
-- DROP POLICY tenant_write ON automation_rules;
-- ALTER TABLE automation_rules DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY tenant_read  ON automation_executions;
-- DROP POLICY tenant_write ON automation_executions;
-- ALTER TABLE automation_executions DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY tenant_read  ON outbox_events;
-- DROP POLICY tenant_write ON outbox_events;
-- ALTER TABLE outbox_events DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY tenant_read  ON connector_credentials;
-- DROP POLICY tenant_write ON connector_credentials;
-- ALTER TABLE connector_credentials DISABLE ROW LEVEL SECURITY;
--
-- ============================================================

-- ── 1. workflow_events: add tenant_id ─────────────────────────────────────
-- The column was omitted from migration 0000. It must exist before RLS
-- can filter it. Fresh schema — no backfill needed.

ALTER TABLE workflow_events
  ADD COLUMN tenant_id UUID NOT NULL;

CREATE INDEX workflow_events_tenant_instance_idx
  ON workflow_events (tenant_id, instance_id);

-- ── 2. tenants: add lifecycle status column ───────────────────────────────
-- text + CHECK is used instead of a Postgres enum so future states can be
-- added without ALTER TYPE (which requires a brief exclusive lock).

ALTER TABLE tenants
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('provisioning', 'active', 'suspended', 'deleted'));

-- ── 3. api_keys table ─────────────────────────────────────────────────────

CREATE TABLE api_keys (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID        NOT NULL,
  name         TEXT        NOT NULL,
  key_hash     TEXT        NOT NULL UNIQUE,
  scopes       TEXT[]      NOT NULL DEFAULT '{}',
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX api_keys_tenant_idx ON api_keys (tenant_id);

-- ── 4. RLS: entity_instances ──────────────────────────────────────────────

ALTER TABLE entity_instances ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_read ON entity_instances
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID);

CREATE POLICY tenant_write ON entity_instances
  FOR ALL
  USING      (tenant_id = current_setting('app.tenant_id', true)::UUID)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::UUID);

-- ── 5. RLS: entity_relations ──────────────────────────────────────────────

ALTER TABLE entity_relations ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_read ON entity_relations
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID);

CREATE POLICY tenant_write ON entity_relations
  FOR ALL
  USING      (tenant_id = current_setting('app.tenant_id', true)::UUID)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::UUID);

-- ── 6. RLS: entity_fields ─────────────────────────────────────────────────
-- System/platform fields have tenant_id IS NULL and are visible to all
-- tenants but not writable by app_user via the write policy.

ALTER TABLE entity_fields ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_field_read ON entity_fields
  FOR SELECT
  USING (
    tenant_id IS NULL
    OR tenant_id = current_setting('app.tenant_id', true)::UUID
  );

CREATE POLICY tenant_field_write ON entity_fields
  FOR ALL
  USING      (tenant_id = current_setting('app.tenant_id', true)::UUID)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::UUID);

-- ── 7. RLS: workflow_events ───────────────────────────────────────────────

ALTER TABLE workflow_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_read ON workflow_events
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID);

CREATE POLICY tenant_write ON workflow_events
  FOR ALL
  USING      (tenant_id = current_setting('app.tenant_id', true)::UUID)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::UUID);

-- ── 8. RLS: automation_rules ──────────────────────────────────────────────

ALTER TABLE automation_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_read ON automation_rules
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID);

CREATE POLICY tenant_write ON automation_rules
  FOR ALL
  USING      (tenant_id = current_setting('app.tenant_id', true)::UUID)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::UUID);

-- ── 9. RLS: automation_executions ────────────────────────────────────────

ALTER TABLE automation_executions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_read ON automation_executions
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID);

CREATE POLICY tenant_write ON automation_executions
  FOR ALL
  USING      (tenant_id = current_setting('app.tenant_id', true)::UUID)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::UUID);

-- ── 10. RLS: outbox_events ────────────────────────────────────────────────

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_read ON outbox_events
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID);

CREATE POLICY tenant_write ON outbox_events
  FOR ALL
  USING      (tenant_id = current_setting('app.tenant_id', true)::UUID)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::UUID);

-- ── 11. RLS: connector_credentials ───────────────────────────────────────

ALTER TABLE connector_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_read ON connector_credentials
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID);

CREATE POLICY tenant_write ON connector_credentials
  FOR ALL
  USING      (tenant_id = current_setting('app.tenant_id', true)::UUID)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::UUID);

-- ── 12. RLS: api_keys ────────────────────────────────────────────────────

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_read ON api_keys
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID);

CREATE POLICY tenant_write ON api_keys
  FOR ALL
  USING      (tenant_id = current_setting('app.tenant_id', true)::UUID)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::UUID);

-- ── 13. Grant api_keys table to app roles (no-op if roles don't exist) ──────
--
-- analytics: excluded (key_hash is a credential; superseded by migration 0009
--            which sets an explicit per-column grant policy for analytics_user)
-- NOTE: the analytics_user GRANT SELECT below is intentionally removed here.
-- Migration 0009 (ALTER DEFAULT PRIVILEGES + explicit grants) supersedes it.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys TO app_user;
  END IF;
  -- analytics_user grant intentionally omitted — see migration 0009 for the
  -- explicit analytics access policy (api_keys is excluded: key_hash is a credential).
END
$$;
