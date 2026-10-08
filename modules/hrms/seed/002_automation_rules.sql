-- modules/hrms/seed/002_automation_rules.sql
-- See modules/crm/seed/002_automation_rules.sql's header for the shared
-- rationale (actions-shape validation, conditions actually gating on the
-- field being unset).

INSERT INTO automation_rules (id, tenant_id, name, is_enabled, trigger_type, trigger_config, conditions, actions, priority)
SELECT
  gen_random_uuid(),
  '{TENANT_ID}',
  'Auto-fill default reason on leave request creation',
  true,
  'entity.created',
  '{"entityType": "Leave Request"}'::jsonb,
  '{"field": "reason", "op": "eq", "value": null}'::jsonb,
  '[{"type": "set_field", "config": {"field": "reason", "value": "No reason provided"}}]'::jsonb,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM automation_rules
  WHERE name = 'Auto-fill default reason on leave request creation' AND tenant_id = '{TENANT_ID}'
);
