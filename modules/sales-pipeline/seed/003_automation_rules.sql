-- modules/sales-pipeline/seed/003_automation_rules.sql
--
-- MATCHING NOTE: same as modules/nsi-amendment/seed/003_automation_rules.sql —
-- packages/automation-engine/src/executor.ts matches rules by tenantId +
-- triggerType + isEnabled only; trigger_config is never read. Entity-type/
-- state scoping lives in the `conditions` tree, built with jsonb_build_object
-- against a subquery-resolved entityTypeId (available once
-- 001_entity_types.sql has run).
--
-- GAP (matches CLAUDE.md/#125): notify is a stub, and even once #125 ships,
-- NotifyConfig.recipientId cannot be resolved from a per-record user_ref
-- field (no `{{assigned_sales_person}}` templating in the automation engine
-- today). All notify rules below are seeded with recipientId=null and
-- is_enabled=false — do not enable without a real recipientId or that
-- engine capability.
--
-- CRON GAP: TriggerEventSchema (packages/automation-engine/src/event-schemas.ts)
-- is a discriminated union of exactly 4 event types — workflow.transitioned,
-- workflow.sla_breached, entity.created, entity.assigned. "schedule.cron" is
-- declared as a TriggerType string literal in types.ts but has no
-- corresponding event schema and nothing in this repo currently produces a
-- schedule.cron event — such a rule cannot fire at all today, not just
-- "unvalidated." The three date-based reminder rules below (document expiry,
-- tender deadline, payment due) are seeded disabled to document intent for
-- when a cron/scheduler producer exists; do not expect them to run.

-- Rule: notify on new sales enquiry
INSERT INTO automation_rules (id, tenant_id, name, is_enabled, trigger_type, trigger_config, conditions, actions, priority)
SELECT
  gen_random_uuid(),
  '{TENANT_ID}',
  'Notify on new sales enquiry',
  false,
  'entity.created',
  '{}'::jsonb,
  jsonb_build_object(
    'op', 'eq', 'field', 'entityTypeId',
    'value', (SELECT id::text FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}')
  ),
  '[{"type": "notify", "config": {"recipientId": null, "channel": ["email"], "payload": {"reason": "new_enquiry"}}}]'::jsonb,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM automation_rules WHERE name = 'Notify on new sales enquiry' AND tenant_id = '{TENANT_ID}'
);

-- Rule: SLA breach reminder while costing is in progress (48h / 2 days)
INSERT INTO automation_rules (id, tenant_id, name, is_enabled, trigger_type, trigger_config, conditions, actions, priority)
SELECT
  gen_random_uuid(),
  '{TENANT_ID}',
  'Reminder: costing overdue',
  false,
  'workflow.sla_breached',
  '{}'::jsonb,
  jsonb_build_object(
    'op', 'and',
    'children', jsonb_build_array(
      jsonb_build_object('op', 'eq', 'field', 'entityTypeId', 'value', (SELECT id::text FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}')),
      jsonb_build_object('op', 'eq', 'field', 'state', 'value', 'costing_in_progress')
    )
  ),
  '[{"type": "notify", "config": {"recipientId": null, "channel": ["email"], "payload": {"reason": "costing_overdue"}}}]'::jsonb,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM automation_rules WHERE name = 'Reminder: costing overdue' AND tenant_id = '{TENANT_ID}'
);

-- Rule: SLA breach reminder while internal approvals are pending (72h / 3 days)
INSERT INTO automation_rules (id, tenant_id, name, is_enabled, trigger_type, trigger_config, conditions, actions, priority)
SELECT
  gen_random_uuid(),
  '{TENANT_ID}',
  'Reminder: internal approval overdue',
  false,
  'workflow.sla_breached',
  '{}'::jsonb,
  jsonb_build_object(
    'op', 'and',
    'children', jsonb_build_array(
      jsonb_build_object('op', 'eq', 'field', 'entityTypeId', 'value', (SELECT id::text FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}')),
      jsonb_build_object('op', 'eq', 'field', 'state', 'value', 'internal_approval_pending')
    )
  ),
  '[{"type": "notify", "config": {"recipientId": null, "channel": ["email"], "payload": {"reason": "approval_overdue"}}}]'::jsonb,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM automation_rules WHERE name = 'Reminder: internal approval overdue' AND tenant_id = '{TENANT_ID}'
);

-- Rule: document expiry reminder — see CRON GAP note above, cannot fire today
INSERT INTO automation_rules (id, tenant_id, name, is_enabled, trigger_type, trigger_config, conditions, actions, priority)
SELECT
  gen_random_uuid(),
  '{TENANT_ID}',
  'Reminder: supporting document expiring soon',
  false,
  'schedule.cron',
  '{"cron": "0 8 * * *"}'::jsonb,
  jsonb_build_object(
    'op', 'and',
    'children', jsonb_build_array(
      jsonb_build_object('op', 'eq', 'field', 'entityTypeId', 'value', (SELECT id::text FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}')),
      jsonb_build_object('op', 'lte', 'field', 'document_expiry_date', 'value', '+7d')
    )
  ),
  '[{"type": "notify", "config": {"recipientId": null, "channel": ["email"], "payload": {"reason": "document_expiring"}}}]'::jsonb,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM automation_rules WHERE name = 'Reminder: supporting document expiring soon' AND tenant_id = '{TENANT_ID}'
);

-- Rule: tender deadline reminder — see CRON GAP note above, cannot fire today
INSERT INTO automation_rules (id, tenant_id, name, is_enabled, trigger_type, trigger_config, conditions, actions, priority)
SELECT
  gen_random_uuid(),
  '{TENANT_ID}',
  'Reminder: tender deadline approaching',
  false,
  'schedule.cron',
  '{"cron": "0 8 * * *"}'::jsonb,
  jsonb_build_object(
    'op', 'and',
    'children', jsonb_build_array(
      jsonb_build_object('op', 'eq', 'field', 'entityTypeId', 'value', (SELECT id::text FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}')),
      jsonb_build_object('op', 'lte', 'field', 'tender_deadline', 'value', '+3d')
    )
  ),
  '[{"type": "notify", "config": {"recipientId": null, "channel": ["email"], "payload": {"reason": "tender_deadline_approaching"}}}]'::jsonb,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM automation_rules WHERE name = 'Reminder: tender deadline approaching' AND tenant_id = '{TENANT_ID}'
);

-- Rule: payment due reminder — see CRON GAP note above, cannot fire today
INSERT INTO automation_rules (id, tenant_id, name, is_enabled, trigger_type, trigger_config, conditions, actions, priority)
SELECT
  gen_random_uuid(),
  '{TENANT_ID}',
  'Reminder: payment due soon',
  false,
  'schedule.cron',
  '{"cron": "0 8 * * *"}'::jsonb,
  jsonb_build_object(
    'op', 'and',
    'children', jsonb_build_array(
      jsonb_build_object('op', 'eq', 'field', 'entityTypeId', 'value', (SELECT id::text FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}')),
      jsonb_build_object('op', 'lte', 'field', 'payment_due_date', 'value', '+3d')
    )
  ),
  '[{"type": "notify", "config": {"recipientId": null, "channel": ["email"], "payload": {"reason": "payment_due_soon"}}}]'::jsonb,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM automation_rules WHERE name = 'Reminder: payment due soon' AND tenant_id = '{TENANT_ID}'
);

-- Rule: auto-move Quotation Sent to Customer -> Customer Follow-up once the
-- 120h/5-day SLA on that state breaches with no customer response recorded.
-- Uses a "transition" action, which IS fully supported today
-- (packages/automation-engine/src/executor.ts's executeTransitionAction) —
-- this rule is enabled by default. Its transitionId is resolved via subquery
-- against the already-inserted workflow_transitions row (002_workflow.sql
-- runs first), since transition ids are gen_random_uuid()'d at insert time.
INSERT INTO automation_rules (id, tenant_id, name, is_enabled, trigger_type, trigger_config, conditions, actions, priority)
SELECT
  gen_random_uuid(),
  '{TENANT_ID}',
  'Auto-move to Customer Follow-up on no response',
  true,
  'workflow.sla_breached',
  '{}'::jsonb,
  jsonb_build_object(
    'op', 'and',
    'children', jsonb_build_array(
      jsonb_build_object('op', 'eq', 'field', 'entityTypeId', 'value', (SELECT id::text FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}')),
      jsonb_build_object('op', 'eq', 'field', 'state', 'value', 'quotation_sent_to_customer')
    )
  ),
  jsonb_build_array(
    jsonb_build_object(
      'type', 'transition',
      'config', jsonb_build_object(
        'transitionId', (
          SELECT wt.id FROM workflow_transitions wt
          JOIN workflows w ON w.id = wt.workflow_id
          WHERE w.entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND w.tenant_id = '{TENANT_ID}'
            AND wt.from_state = 'quotation_sent_to_customer' AND wt.to_state = 'customer_followup'
        ),
        'comment', 'Auto-moved: no customer response within SLA'
      )
    )
  ),
  0
WHERE NOT EXISTS (
  SELECT 1 FROM automation_rules WHERE name = 'Auto-move to Customer Follow-up on no response' AND tenant_id = '{TENANT_ID}'
);

-- Rule: notify on final outcome (won/lost)
INSERT INTO automation_rules (id, tenant_id, name, is_enabled, trigger_type, trigger_config, conditions, actions, priority)
SELECT
  gen_random_uuid(),
  '{TENANT_ID}',
  'Notify Sales Manager on order won or lost',
  false,
  'workflow.transitioned',
  '{}'::jsonb,
  jsonb_build_object(
    'op', 'and',
    'children', jsonb_build_array(
      jsonb_build_object('op', 'eq', 'field', 'entityTypeId', 'value', (SELECT id::text FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}')),
      jsonb_build_object(
        'op', 'or',
        'children', jsonb_build_array(
          jsonb_build_object('op', 'eq', 'field', 'toState', 'value', 'order_won'),
          jsonb_build_object('op', 'eq', 'field', 'toState', 'value', 'order_lost')
        )
      )
    )
  ),
  '[{"type": "notify", "config": {"recipientId": null, "channel": ["email"], "payload": {"reason": "final_outcome"}}}]'::jsonb,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM automation_rules WHERE name = 'Notify Sales Manager on order won or lost' AND tenant_id = '{TENANT_ID}'
);
