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

-- docs/specs/oncall-routing.md T13/R8 — resolve_oncall fires on BOTH
-- entity.created (team_id set at creation) and entity.updated (team_id
-- changed later) — two separate rule rows since trigger_type is singular
-- per automation_rules row. `conditions` is intentionally NULL: the
-- condition-tree evaluator (packages/workflow-engine/src/condition-
-- evaluator.ts) only supports flat current-value field lookups, not
-- old/new diffing, so "did team_id actually change" is checked inside
-- packages/automation-engine/src/actions/resolve-oncall.ts itself (reads
-- event.fields.team_id for entity.created, event.changed.team_id for
-- entity.updated) — this rule fires on every relevant event and the action
-- self-guards, matching this file's existing "conditions can't see field
-- values, action does its own guard" pattern (see modules/tender's
-- 003_automation_rules.sql for the same convention on entity.created).
--
-- KNOWN PREREQUISITE GAP: team_id is not yet a seeded entity field on
-- 'ticket' (see 001_entity_types.sql's header comment) -- this rule is a
-- no-op until that lands, by design (the action returns early when
-- team_id is absent).
INSERT INTO automation_rules (id, tenant_id, name, is_enabled, trigger_type, trigger_config, conditions, actions, priority)
SELECT
  gen_random_uuid(),
  '{TENANT_ID}',
  'Auto-assign on-call user when team is set on ticket creation',
  true,
  'entity.created',
  '{"entityType": "ticket"}'::jsonb,
  NULL,
  '[{"type": "resolve_oncall", "config": {}}]'::jsonb,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM automation_rules
  WHERE name = 'Auto-assign on-call user when team is set on ticket creation' AND tenant_id = '{TENANT_ID}'
);

INSERT INTO automation_rules (id, tenant_id, name, is_enabled, trigger_type, trigger_config, conditions, actions, priority)
SELECT
  gen_random_uuid(),
  '{TENANT_ID}',
  'Auto-assign on-call user when ticket team changes',
  true,
  'entity.updated',
  '{"entityType": "ticket"}'::jsonb,
  NULL,
  '[{"type": "resolve_oncall", "config": {}}]'::jsonb,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM automation_rules
  WHERE name = 'Auto-assign on-call user when ticket team changes' AND tenant_id = '{TENANT_ID}'
);
