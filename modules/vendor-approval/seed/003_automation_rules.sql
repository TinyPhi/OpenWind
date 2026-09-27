-- modules/vendor-approval/seed/003_automation_rules.sql

-- One notify rule per review-state entry. Shipped DISABLED with no
-- recipientId: NotifyConfig only supports a fixed user id (no role- or
-- assignee-based recipient — automation-engine/src/actions/notify.ts), and
-- module seed SQL is tenant-agnostic, so it cannot know which user holds
-- it_security / legal / finance_approver in a given tenant. The tenant admin
-- sets recipientId and enables each rule in the automation builder. Role-based
-- recipients are deferred to #607 (docs/specs/vendor-approval.md §D1).
--
-- SCOPING: the executor matches rules on trigger_type + conditions only — it
-- never reads trigger_config (packages/automation-engine/src/executor.ts). A
-- bare toState condition would therefore fire for ANY entity type in the
-- tenant whose workflow has a same-named state. Each condition also pins
-- entityTypeId to this tenant's vendor entity type, resolved at install time.

INSERT INTO automation_rules (id, tenant_id, name, is_enabled, trigger_type, trigger_config, conditions, actions, priority)
SELECT
  gen_random_uuid(),
  '{TENANT_ID}',
  'Vendor approval: notify IT Security on entry to it_security_review',
  false,
  'workflow.transitioned',
  '{"entityType": "vendor"}'::jsonb,
  jsonb_build_object('op', 'and', 'children', jsonb_build_array(
    jsonb_build_object('op', 'eq', 'field', 'entityTypeId', 'value', (SELECT id::text FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}')),
    jsonb_build_object('op', 'eq', 'field', 'toState', 'value', 'it_security_review')
  )),
  '[{"type": "notify", "config": {"payload": {"title": "Vendor awaiting IT Security review", "body": "A vendor request has entered IT Security review and is waiting on your decision."}}}]'::jsonb,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM automation_rules
  WHERE name = 'Vendor approval: notify IT Security on entry to it_security_review' AND tenant_id = '{TENANT_ID}'
);

INSERT INTO automation_rules (id, tenant_id, name, is_enabled, trigger_type, trigger_config, conditions, actions, priority)
SELECT
  gen_random_uuid(),
  '{TENANT_ID}',
  'Vendor approval: notify Legal on entry to legal_review',
  false,
  'workflow.transitioned',
  '{"entityType": "vendor"}'::jsonb,
  jsonb_build_object('op', 'and', 'children', jsonb_build_array(
    jsonb_build_object('op', 'eq', 'field', 'entityTypeId', 'value', (SELECT id::text FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}')),
    jsonb_build_object('op', 'eq', 'field', 'toState', 'value', 'legal_review')
  )),
  '[{"type": "notify", "config": {"payload": {"title": "Vendor awaiting Legal review", "body": "A vendor request has entered Legal review and is waiting on your decision."}}}]'::jsonb,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM automation_rules
  WHERE name = 'Vendor approval: notify Legal on entry to legal_review' AND tenant_id = '{TENANT_ID}'
);

INSERT INTO automation_rules (id, tenant_id, name, is_enabled, trigger_type, trigger_config, conditions, actions, priority)
SELECT
  gen_random_uuid(),
  '{TENANT_ID}',
  'Vendor approval: notify Finance on entry to pending_final_approval',
  false,
  'workflow.transitioned',
  '{"entityType": "vendor"}'::jsonb,
  jsonb_build_object('op', 'and', 'children', jsonb_build_array(
    jsonb_build_object('op', 'eq', 'field', 'entityTypeId', 'value', (SELECT id::text FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}')),
    jsonb_build_object('op', 'eq', 'field', 'toState', 'value', 'pending_final_approval')
  )),
  '[{"type": "notify", "config": {"payload": {"title": "Vendor awaiting Finance review", "body": "A vendor request has entered Finance review and is waiting on your decision."}}}]'::jsonb,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM automation_rules
  WHERE name = 'Vendor approval: notify Finance on entry to pending_final_approval' AND tenant_id = '{TENANT_ID}'
);
