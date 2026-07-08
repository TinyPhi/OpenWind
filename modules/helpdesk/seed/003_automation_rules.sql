-- modules/helpdesk/seed/003_automation_rules.sql

-- Insert rule: Auto-set priority to 'medium' on Ticket creation if not specified
INSERT INTO automation_rules (id, tenant_id, name, is_enabled, trigger_type, trigger_config, conditions, actions, priority)
SELECT 
  gen_random_uuid(), 
  '{TENANT_ID}', 
  'Auto-set default priority on ticket creation', 
  true, 
  'entity.created', 
  '{"entityType": "ticket"}'::jsonb, 
  NULL, 
  '[{"type": "set_field", "config": {"field": "priority", "value": "medium"}}]'::jsonb,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM automation_rules 
  WHERE name = 'Auto-set default priority on ticket creation' AND tenant_id = '{TENANT_ID}'
);
