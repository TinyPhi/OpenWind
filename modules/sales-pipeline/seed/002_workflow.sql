-- modules/sales-pipeline/seed/002_workflow.sql

-- {WORKFLOW_NAME} resolves to the module's catalog display name (e.g. "Sales
-- Pipeline") at install time — see apps/api/src/services/module-service.ts.
-- Every other lookup of this workflow in this file (and in
-- 003_automation_rules.sql) keys on entity_type_id, NOT name, so the display
-- name can be safely customized without breaking seed-time lookups.
INSERT INTO workflows (id, tenant_id, entity_type_id, name, initial_state)
SELECT gen_random_uuid(), '{TENANT_ID}', (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'), '{WORKFLOW_NAME}', 'new_enquiry'
WHERE NOT EXISTS (
  SELECT 1 FROM workflows
  WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}')
);

-- Clean up existing states/transitions for this workflow to ensure idempotency
DELETE FROM workflow_transitions WHERE workflow_id = (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}');
DELETE FROM workflow_states WHERE workflow_id = (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}');

-- sla_hours: Costing in Progress = 48h (2 days), Internal Approval Pending =
-- 72h (3 days), Quotation Sent to Customer = 120h (5 days) — placeholders
-- per the design doc, not yet client-confirmed.
INSERT INTO workflow_states (id, workflow_id, name, label, color, is_terminal, sla_hours, sort_order)
VALUES
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'new_enquiry', 'New Enquiry', '#6b7280', false, NULL, 1),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'costing_in_progress', 'Costing in Progress', '#3b82f6', false, 48, 2),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'quotation_prepared', 'Quotation Prepared', '#8b5cf6', false, NULL, 3),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'internal_approval_pending', 'Internal Approval Pending', '#f59e0b', false, 72, 4),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'quotation_sent_to_customer', 'Quotation Sent to Customer', '#0ea5e9', false, 120, 5),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'customer_followup', 'Customer Follow-up', '#eab308', false, NULL, 6),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'negotiation', 'Negotiation', '#f97316', false, NULL, 7),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'order_won', 'Order Won', '#059669', true, NULL, 8),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'order_lost', 'Order Lost', '#dc2626', true, NULL, 9),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'on_hold_dropped', 'On Hold / Dropped', '#71717a', true, NULL, 10);

-- allowed_roles: only agent/admin exist as global roles (same ROLE NOTE as
-- modules/nsi-amendment) — Sales/Costing/Management distinctions are carried
-- by the user_ref fields, not by transition roles.
INSERT INTO workflow_transitions (id, workflow_id, from_state, to_state, label, allowed_roles, conditions, requires_comment, requires_fields)
VALUES
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'new_enquiry', 'costing_in_progress', 'Start Costing', ARRAY['agent', 'admin']::text[], NULL, false, ARRAY['customer_name', 'enquiry_source', 'product_service_required']::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'costing_in_progress', 'quotation_prepared', 'Costing Done', ARRAY['agent', 'admin']::text[], '{"op": "eq", "field": "costing_status", "value": "done"}'::jsonb, false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'quotation_prepared', 'internal_approval_pending', 'Send for Internal Approval', ARRAY['agent', 'admin']::text[], NULL, false, ARRAY['quotation_amount']::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'internal_approval_pending', 'quotation_sent_to_customer', 'Send Quotation to Customer', ARRAY['agent', 'admin']::text[], '{"op": "and", "children": [{"op": "eq", "field": "technical_approval_status", "value": "approved"}, {"op": "eq", "field": "finance_approval_status", "value": "approved"}, {"op": "eq", "field": "qa_approval_status", "value": "approved"}, {"op": "eq", "field": "management_approval_status", "value": "approved"}]}'::jsonb, false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'quotation_sent_to_customer', 'customer_followup', 'No Response Yet', ARRAY['agent', 'admin']::text[], NULL, false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'customer_followup', 'negotiation', 'Customer Responded', ARRAY['agent', 'admin']::text[], NULL, true, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'negotiation', 'quotation_prepared', 'Re-cost Quotation', ARRAY['agent', 'admin']::text[], NULL, false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'negotiation', 'order_won', 'Mark Order Won', ARRAY['agent', 'admin']::text[], NULL, false, ARRAY['order_value']::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'customer_followup', 'order_won', 'Mark Order Won', ARRAY['agent', 'admin']::text[], NULL, false, ARRAY['order_value']::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'negotiation', 'order_lost', 'Mark Order Lost', ARRAY['agent', 'admin']::text[], NULL, true, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'customer_followup', 'order_lost', 'Mark Order Lost', ARRAY['agent', 'admin']::text[], NULL, true, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'new_enquiry', 'on_hold_dropped', 'Put On Hold / Drop', ARRAY['agent', 'admin']::text[], NULL, true, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'costing_in_progress', 'on_hold_dropped', 'Put On Hold / Drop', ARRAY['agent', 'admin']::text[], NULL, true, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'quotation_sent_to_customer', 'on_hold_dropped', 'Put On Hold / Drop', ARRAY['agent', 'admin']::text[], NULL, true, ARRAY[]::text[]);
