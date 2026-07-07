-- modules/tender/seed/003_automation_rules.sql
--
-- GAP (see README.md "Known gap"): the automation-engine action executor
-- (packages/automation-engine/src/executor.ts) only dispatches four action
-- types — "notify", "set_field", "transition", "webhook" — none of which can
-- call packages/entity-engine/src/child-relations.ts::createChildRelation().
-- There is currently NO action type that creates a child ticket. The rule
-- below is written against the trigger/condition side (which the engine DOES
-- support today) but its action list uses a "create_child" action type that
-- does not exist yet in the executor's switch statement. Installing this rule
-- as-is will not throw at seed time (actions is a jsonb blob with no FK to
-- code) but will log "Automation: unhandled action type" and silently no-op
-- every time it fires — costing_child_id will never get set automatically.
--
-- Do NOT treat this file as functionally complete. Either:
--   (a) implement a "create_child" action handler in automation-engine
--       (calling createChildRelation, then set_field-ing costing_child_id
--       back onto the parent) before enabling this rule, or
--   (b) fall back to the tender_owner manually creating the costing child
--       ticket and setting costing_child_id by hand until (a) ships.
-- Tracked as a Phase-3-adjacent engine gap, not a module config gap.

INSERT INTO automation_rules (id, tenant_id, name, is_enabled, trigger_type, trigger_config, conditions, actions, priority)
SELECT
  gen_random_uuid(),
  '{TENANT_ID}',
  'Spawn costing child ticket on first entry to pending_costing_review',
  false, -- disabled by default until the create_child action type ships (see gap note above)
  'workflow.transitioned',
  '{"entityType": "tender"}'::jsonb,
  '{
    "and": [
      { "op": "eq", "field": "toState", "value": "pending_costing_review" },
      { "op": "is_null", "field": "costing_child_id" }
    ]
  }'::jsonb,
  '[
    {
      "type": "create_child",
      "config": {
        "assignToRole": "costing_lead",
        "descriptionTemplate": "{{title}}\n\n{{summary}}",
        "writeBackField": "costing_child_id"
      }
    }
  ]'::jsonb,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM automation_rules
  WHERE name = 'Spawn costing child ticket on first entry to pending_costing_review' AND tenant_id = '{TENANT_ID}'
);
