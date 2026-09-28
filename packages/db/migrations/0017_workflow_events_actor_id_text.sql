-- SUPERSEDED (2026-09-22): the workflow_events_masked view created below is
-- dropped by migration 0119. It could never work — it reads `metadata` in
-- order to redact it, while 0112 set security_invoker = true, so the caller
-- needed the very column it hides. Reporting now classifies events through
-- workflow_events.event_type (0117) and is not granted the payload at all
-- (0118). This migration is left intact for replay; expect a fresh build to
-- create the view here and drop it at 0119.
-- See docs/specs/reporting-metadata-masking-repair.md
-- Migration: change workflow_events.actor_id from uuid to text
-- Zitadel issues snowflake IDs (numeric strings) not UUIDs; uuid column rejects them.

-- Down:
-- DROP VIEW IF EXISTS workflow_events_masked;
-- ALTER TABLE workflow_events ALTER COLUMN actor_id TYPE uuid USING actor_id::uuid;
-- (then recreate workflow_events_masked view from migration 0009)

-- workflow_events_masked depends on actor_id — drop it, alter, then recreate.
DROP VIEW IF EXISTS workflow_events_masked;

ALTER TABLE workflow_events ALTER COLUMN actor_id TYPE text USING actor_id::text;

-- Recreate the view (definition from migration 0009_analytics_user_grants)
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
        ON ef.entity_type_id = ei.entity_type_id
        AND ef.name = kv.key
    ),
    '{}'::jsonb
  ) AS metadata
FROM workflow_events we
LEFT JOIN entity_instances ei ON ei.id = we.instance_id;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_user') THEN
    EXECUTE 'GRANT SELECT ON workflow_events_masked TO analytics_user';
  END IF;
END
$$;
