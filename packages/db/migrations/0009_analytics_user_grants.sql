-- SUPERSEDED (2026-09-22): the workflow_events_masked view created below is
-- dropped by migration 0119. It could never work — it reads `metadata` in
-- order to redact it, while 0112 set security_invoker = true, so the caller
-- needed the very column it hides. Reporting now classifies events through
-- workflow_events.event_type (0117) and is not granted the payload at all
-- (0118). This migration is left intact for replay; expect a fresh build to
-- create the view here and drop it at 0119.
-- See docs/specs/reporting-metadata-masking-repair.md
-- ============================================================
-- Migration: 0009_analytics_user_grants
-- Locks down analytics_user to an explicit column allowlist.
-- Closes the BYPASSRLS over-exposure gap (issue #2 item 3).
-- ============================================================
--
-- DOWN MIGRATION (rollback):
-- DROP VIEW IF EXISTS workflow_events_masked;
-- -- Re-grant the previous blanket SELECT (reverts to pre-migration state)
-- DO $$
-- BEGIN
--   IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_user') THEN
--     GRANT SELECT ON ALL TABLES IN SCHEMA public TO analytics_user;
--   END IF;
-- END $$;
--
-- ── Convention (enforced by CI lint in future migrations) ─────────────────────
-- Every migration that creates a new table MUST include one of:
--   -- analytics: excluded (reason)
--   -- analytics: included(col1, col2, ...)
-- New tables default to NO ACCESS for analytics_user because of the
-- ALTER DEFAULT PRIVILEGES REVOKE below.

-- ── 1. Revoke future default grants ──────────────────────────────────────────
-- Ensures any table created after this migration is NOT accessible to
-- analytics_user unless explicitly granted. This is the primary defence —
-- CI lint is a secondary safety net.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_user') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM analytics_user';
  END IF;
END
$$;

-- ── 2. Revoke all current table grants from analytics_user ───────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_user') THEN
    -- Revoke blanket grants added in prior migrations (0001 granted api_keys)
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM analytics_user';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM analytics_user';
  END IF;
END
$$;

-- ── 3. Explicit per-table, per-column grants ──────────────────────────────────
-- Each table lists exactly the columns analytics_user may read.
-- Sensitive columns (fields JSONB, credentials, key_hash, metadata) are
-- excluded unless safe via a masked view.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_user') THEN
    RETURN;
  END IF;

  -- tenants: all non-sensitive columns
  -- analytics: included(id,name,slug,plan,status,created_at,updated_at)
  EXECUTE 'GRANT SELECT (id, name, slug, plan, status, created_at, updated_at) ON tenants TO analytics_user';

  -- entity_types: full read (no sensitive columns)
  -- analytics: included(id,tenant_id,name,plural,icon,module_id,allow_custom_fields,created_at)
  EXECUTE 'GRANT SELECT (id, tenant_id, name, plural, icon, module_id, allow_custom_fields, created_at) ON entity_types TO analytics_user';

  -- entity_fields: full read including sensitivity column (not a secret — it is metadata)
  -- analytics: included(id,entity_type_id,tenant_id,name,label,field_type,config,
  --            is_required,is_indexed,is_system,sort_order,sensitivity,created_at)
  EXECUTE 'GRANT SELECT (id, entity_type_id, tenant_id, name, label, field_type, config, is_required, is_indexed, is_system, sort_order, sensitivity, created_at) ON entity_fields TO analytics_user';

  -- entity_instances: EXCLUDE fields JSONB — may contain raw PII.
  -- Use the sensitivity map + application layer for field-level analytics.
  -- analytics: included(id,entity_type_id,tenant_id,workflow_id,current_state,
  --            created_by,assigned_to,created_at,updated_at,deleted_at)
  EXECUTE 'GRANT SELECT (id, entity_type_id, tenant_id, workflow_id, current_state, created_by, assigned_to, created_at, updated_at, deleted_at) ON entity_instances TO analytics_user';

  -- entity_relations: full read (no sensitive columns)
  -- analytics: included(id,tenant_id,from_instance_id,to_instance_id,relation_type,created_at)
  EXECUTE 'GRANT SELECT (id, tenant_id, from_instance_id, to_instance_id, relation_type, created_at) ON entity_relations TO analytics_user';

  -- workflows, workflow_states, workflow_transitions: full read (config only, no PII)
  -- analytics: included(all columns)
  EXECUTE 'GRANT SELECT ON workflows TO analytics_user';
  EXECUTE 'GRANT SELECT ON workflow_states TO analytics_user';
  EXECUTE 'GRANT SELECT ON workflow_transitions TO analytics_user';

  -- workflow_events: EXCLUDED — metadata JSONB may contain PII.
  -- Access is via the workflow_events_masked view created in step 4 below.
  -- analytics: excluded (metadata may contain PII/financial values — use workflow_events_masked)

  -- automation_rules: EXCLUDE actions JSONB (may contain webhook URLs, API keys in config)
  -- analytics: included(id,tenant_id,name,is_enabled,trigger_type,priority,created_at,updated_at)
  EXECUTE 'GRANT SELECT (id, tenant_id, name, is_enabled, trigger_type, priority, created_at, updated_at) ON automation_rules TO analytics_user';

  -- automation_executions: full read (result JSONB contains only counts, no PII)
  -- analytics: included(id,tenant_id,rule_id,trigger_event,status,result,error,started_at,completed_at)
  EXECUTE 'GRANT SELECT (id, tenant_id, rule_id, trigger_event, status, result, error, started_at, completed_at) ON automation_executions TO analytics_user';

  -- outbox_events: EXCLUDED — payload may contain entity field data
  -- analytics: excluded (payload mirrors entity_instances.fields — same PII risk)

  -- dead_letter_events: EXCLUDED — same reason as outbox_events
  -- analytics: excluded (mirrors outbox_events)

  -- api_keys: EXCLUDED — key_hash is a credential; scopes are operational metadata.
  -- Prior migration 0001 granted SELECT on api_keys; that grant is revoked above.
  -- analytics: excluded (key_hash is a credential)

  -- tenant_users: EXCLUDED — user IDs are PII under GDPR
  -- analytics: excluded (user_id is PII)

  -- connector_credentials: EXCLUDED — encrypted credential ciphertext
  -- analytics: excluded (credentials column is encrypted ciphertext)

END
$$;

-- ── 4. Masked view for workflow_events ────────────────────────────────────────
-- Provides analytics_user access to workflow event metadata with PII/financial
-- values replaced at query time.  Application-layer redaction (engine.ts) is
-- the primary defence; this view is a secondary safety net.

-- entity_instances is joined once per row in the outer query so that
-- ei.entity_type_id is available to the inner aggregate without a
-- correlated subquery per metadata key (avoids N×K index scans).
CREATE OR REPLACE VIEW workflow_events_masked AS
SELECT
  we.id,
  we.tenant_id,
  we.workflow_id,
  we.instance_id,
  we.from_state,
  we.to_state,
  we.triggered_by,
  we.actor_id,
  we.comment,
  we.idempotency_key,
  we.created_at,
  -- Rebuild the metadata JSONB, replacing PII/financial field values with [REDACTED].
  -- Fields not found in entity_fields (non-field metadata keys like 'comment',
  -- 'triggeredBy') pass through verbatim — the LEFT JOIN returns NULL sensitivity,
  -- which is not in ('pii', 'financial').
  COALESCE(
    (
      SELECT jsonb_object_agg(
        kv.key,
        CASE
          WHEN ef.sensitivity IN ('pii', 'financial')
          THEN '"[REDACTED]"'::jsonb
          ELSE kv.value
        END
      )
      FROM jsonb_each(we.metadata) AS kv(key, value)
      LEFT JOIN entity_fields ef
        ON ef.entity_type_id = ei.entity_type_id  -- resolved once per outer row
        AND ef.name = kv.key
    ),
    '{}'::jsonb
  ) AS metadata
FROM workflow_events we
LEFT JOIN entity_instances ei ON ei.id = we.instance_id;

-- Grant analytics_user access to the masked view only (not the base table)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_user') THEN
    EXECUTE 'GRANT SELECT ON workflow_events_masked TO analytics_user';
  END IF;
END
$$;
