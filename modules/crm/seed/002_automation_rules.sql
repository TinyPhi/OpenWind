-- modules/crm/seed/002_automation_rules.sql
--
-- `actions` shape must match packages/automation-engine/src/executor.ts's
-- `runAction` switch exactly, and is validated against apps/api/src/routes/
-- automation-rules/schemas.ts's ActionConfigSchema by tests/integration/
-- module-seed-automation-rules.test.ts -- see that file for why (modules/
-- helpdesk/seed/003_automation_rules.sql's header explains the original gap:
-- a wrong action shape shipped silently for every install until #126).
--
-- Unlike helpdesk's earlier "Auto-set priority" rule, this one's `conditions`
-- actually gates on the field being unset (`eq null`) rather than firing
-- unconditionally on every creation -- the condition-tree evaluator
-- (packages/workflow-engine/src/condition-evaluator.ts) reads the event's
-- current field values, which at entity.created time are exactly what the
-- client submitted, so "field is currently null" is a real, supported check
-- here (not the old/new diff that resolve_oncall-style rules need to self-guard
-- against instead).

INSERT INTO automation_rules (id, tenant_id, name, is_enabled, trigger_type, trigger_config, conditions, actions, priority)
SELECT
  gen_random_uuid(),
  '{TENANT_ID}',
  'Auto-set default lead source on deal creation',
  true,
  'entity.created',
  '{"entityType": "Deal"}'::jsonb,
  '{"field": "source", "op": "eq", "value": null}'::jsonb,
  '[{"type": "set_field", "config": {"field": "source", "value": "inbound"}}]'::jsonb,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM automation_rules
  WHERE name = 'Auto-set default lead source on deal creation' AND tenant_id = '{TENANT_ID}'
);
