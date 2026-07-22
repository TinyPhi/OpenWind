-- modules/nsi-amendment/seed/003_automation_rules.sql
--
-- MATCHING NOTE: packages/automation-engine/src/executor.ts selects candidate
-- rules by tenantId + triggerType + isEnabled ONLY — trigger_config is never
-- read by the matcher (confirmed: no reference to triggerConfig anywhere in
-- executor.ts). Scoping to a specific entity type/state MUST live in the
-- `conditions` tree instead, matched against event fields (entityTypeId,
-- toState/fromState, state, slaHours, etc. per event-schemas.ts) — a bare
-- `{"entityType": "..."}` in trigger_config would silently do nothing and
-- the rule would fire for every tenant event of that triggerType. Every rule
-- below scopes on entityTypeId via a subquery against entity_types, resolved
-- at seed time with jsonb_build_object (the id doesn't exist until
-- 001_entity_types.sql has run, which it has by this point in the install).
--
-- GAP (matches CLAUDE.md/#125): the notify action
-- (packages/automation-engine/src/actions/notify.ts) is a stub — logs only,
-- no real delivery, until #125 wires a provider.
--
-- SECOND GAP found while authoring this file: even once #125 ships,
-- NotifyConfig.recipientId (packages/automation-engine/src/types.ts) is a
-- plain fixed string, not a template — there is no `{{sales_owner}}`-style
-- resolution to read a per-record user_ref field at fire time. All notify
-- rules below are seeded with recipientId=null and is_enabled=false so they
-- document the intended trigger/condition shape without silently misfiring
-- against the wrong (or no) recipient. Do not enable without a real
-- recipientId or that engine capability landing first.

-- Rule: notify reviewers when a new NSI request is created
INSERT INTO automation_rules (id, tenant_id, name, is_enabled, trigger_type, trigger_config, conditions, actions, priority)
SELECT
  gen_random_uuid(),
  '{TENANT_ID}',
  'Notify reviewers on NSI request creation',
  false,
  'entity.created',
  '{}'::jsonb,
  jsonb_build_object(
    'op', 'eq', 'field', 'entityTypeId',
    'value', (SELECT id::text FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}')
  ),
  '[{"type": "notify", "config": {"recipientId": null, "channel": ["email"], "payload": {"reason": "new_nsi_request"}}}]'::jsonb,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM automation_rules WHERE name = 'Notify reviewers on NSI request creation' AND tenant_id = '{TENANT_ID}'
);

-- Rule: notify Sales owner once submitted to Railway (SLA clock starts)
INSERT INTO automation_rules (id, tenant_id, name, is_enabled, trigger_type, trigger_config, conditions, actions, priority)
SELECT
  gen_random_uuid(),
  '{TENANT_ID}',
  'Notify Sales owner on submission to Railway',
  false,
  'workflow.transitioned',
  '{}'::jsonb,
  jsonb_build_object(
    'op', 'and',
    'children', jsonb_build_array(
      jsonb_build_object('op', 'eq', 'field', 'entityTypeId', 'value', (SELECT id::text FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}')),
      jsonb_build_object('op', 'eq', 'field', 'toState', 'value', 'submitted_to_railway')
    )
  ),
  '[{"type": "notify", "config": {"recipientId": null, "channel": ["email"], "payload": {"reason": "submitted_to_railway"}}}]'::jsonb,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM automation_rules WHERE name = 'Notify Sales owner on submission to Railway' AND tenant_id = '{TENANT_ID}'
);

-- Rule: SLA breach reminder while awaiting Railway's response (168h / 7 days,
-- set on the 'awaiting_railway_response' state in 002_workflow.sql)
INSERT INTO automation_rules (id, tenant_id, name, is_enabled, trigger_type, trigger_config, conditions, actions, priority)
SELECT
  gen_random_uuid(),
  '{TENANT_ID}',
  'Reminder: overdue follow-up on Railway response',
  false,
  'workflow.sla_breached',
  '{}'::jsonb,
  jsonb_build_object(
    'op', 'and',
    'children', jsonb_build_array(
      jsonb_build_object('op', 'eq', 'field', 'entityTypeId', 'value', (SELECT id::text FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}')),
      jsonb_build_object('op', 'eq', 'field', 'state', 'value', 'awaiting_railway_response')
    )
  ),
  '[{"type": "notify", "config": {"recipientId": null, "channel": ["email"], "payload": {"reason": "railway_response_overdue"}}}]'::jsonb,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM automation_rules WHERE name = 'Reminder: overdue follow-up on Railway response' AND tenant_id = '{TENANT_ID}'
);

-- Rule: SLA breach reminder while documents are pending (72h / 3 days, set
-- on the 'documents_pending' state in 002_workflow.sql)
INSERT INTO automation_rules (id, tenant_id, name, is_enabled, trigger_type, trigger_config, conditions, actions, priority)
SELECT
  gen_random_uuid(),
  '{TENANT_ID}',
  'Reminder: documents still pending',
  false,
  'workflow.sla_breached',
  '{}'::jsonb,
  jsonb_build_object(
    'op', 'and',
    'children', jsonb_build_array(
      jsonb_build_object('op', 'eq', 'field', 'entityTypeId', 'value', (SELECT id::text FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}')),
      jsonb_build_object('op', 'eq', 'field', 'state', 'value', 'documents_pending')
    )
  ),
  '[{"type": "notify", "config": {"recipientId": null, "channel": ["email"], "payload": {"reason": "documents_pending_overdue"}}}]'::jsonb,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM automation_rules WHERE name = 'Reminder: documents still pending' AND tenant_id = '{TENANT_ID}'
);

-- Rule: notify on final outcome (approved/rejected)
INSERT INTO automation_rules (id, tenant_id, name, is_enabled, trigger_type, trigger_config, conditions, actions, priority)
SELECT
  gen_random_uuid(),
  '{TENANT_ID}',
  'Notify on NSI request approved or rejected',
  false,
  'workflow.transitioned',
  '{}'::jsonb,
  jsonb_build_object(
    'op', 'and',
    'children', jsonb_build_array(
      jsonb_build_object('op', 'eq', 'field', 'entityTypeId', 'value', (SELECT id::text FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}')),
      jsonb_build_object(
        'op', 'or',
        'children', jsonb_build_array(
          jsonb_build_object('op', 'eq', 'field', 'toState', 'value', 'approved'),
          jsonb_build_object('op', 'eq', 'field', 'toState', 'value', 'rejected')
        )
      )
    )
  ),
  '[{"type": "notify", "config": {"recipientId": null, "channel": ["email"], "payload": {"reason": "final_outcome"}}}]'::jsonb,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM automation_rules WHERE name = 'Notify on NSI request approved or rejected' AND tenant_id = '{TENANT_ID}'
);
