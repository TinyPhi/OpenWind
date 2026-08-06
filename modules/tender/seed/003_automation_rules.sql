-- modules/tender/seed/003_automation_rules.sql
--
-- #162 RESOLVED: packages/automation-engine/src/actions/create-child.ts now
-- implements the "create_child" action type (calls createChildRelation, then
-- writes costing_child_id back onto the parent), registered in executor.ts's
-- switch. This rule now actually fires instead of silently no-op'ing.
--
-- CONDITION NOTE — two separate bugs fixed here, both of which made this
-- condition tree always evaluate to false (so the rule could never fire at
-- all, regardless of the create_child action existing):
--   1. The tree shape was `{"and": [...]}`. The actual contract
--      (packages/workflow-engine/src/types.ts's ConditionTree) is
--      `{"op": "and", "children": [...]}`. evaluateConditionTree checks for
--      a `children` key, found none, fell through to evaluateFieldCondition
--      treating the whole object as a FieldCondition with `op` undefined —
--      always false.
--   2. The original draft used "is_null" as an operator — that operator does
--      not exist in condition-evaluator.ts (only
--      eq/neq/gt/gte/lt/lte/contains/in/empty/not_empty). Changed to "empty".
-- Note this condition still can't see costing_child_id's actual value today —
-- workflow.transitioned events carry no field data for condition matching
-- (only entity.created does) — so the "empty" check always evaluates true
-- here. The real exactly-once guarantee comes from create-child.ts's own
-- idempotency check against the parent's current writeBackField value, not
-- from this condition. Kept for forward-compatibility (self-documenting
-- intent, and correct if executor.ts's field-merging is ever extended to
-- workflow.transitioned).
--
-- ROLE NOTE (still open, unchanged from before #162): this platform has no
-- "costing_lead" role (only agent/admin exist globally) — the child ticket's
-- assignee is a specific user, not a role lookup. "assignToUserId" below is
-- left null: create-child.ts has no per-tenant default-assignee config to
-- resolve it from yet, so the created child ticket is unassigned until an
-- agent manually assigns it. Isolation still holds in the meantime — nothing
-- exposes the parent's client_name/finance_details to the child — but the
-- "costing analyst never sees the parent" guarantee via assignment scoping
-- only takes effect once someone is assigned. Tracked as a follow-up, not a
-- blocker for enabling this rule.

INSERT INTO automation_rules (id, tenant_id, name, is_enabled, trigger_type, trigger_config, conditions, actions, priority)
SELECT
  gen_random_uuid(),
  '{TENANT_ID}',
  'Spawn costing child ticket on first entry to pending_costing_review',
  true,
  'workflow.transitioned',
  '{"entityType": "tender"}'::jsonb,
  '{
    "op": "and",
    "children": [
      { "op": "eq", "field": "toState", "value": "pending_costing_review" },
      { "op": "empty", "field": "costing_child_id" }
    ]
  }'::jsonb,
  '[
    {
      "type": "create_child",
      "config": {
        "assignToUserId": null,
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
