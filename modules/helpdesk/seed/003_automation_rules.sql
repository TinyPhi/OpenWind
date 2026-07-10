-- modules/helpdesk/seed/003_automation_rules.sql
--
-- `actions` shape must match packages/automation-engine/src/executor.ts's
-- `runAction` switch exactly — e.g. `{"type": "set_field", "config": {"field":
-- ..., "value": ...}}`, not a flat `{"type": "set-field", "field": ..., ...}`.
-- This file previously shipped the wrong shape and silently no-opped for
-- every install until #126 found it. This raw INSERT bypasses the Zod
-- validation in apps/api/src/routes/automation-rules/schemas.ts's
-- ActionConfigSchema (that only runs for API-created/updated rules) — there
-- is no automated check for seed SQL, so double-check the shape by hand
-- against executor.ts before adding a new automation rule seed.

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
