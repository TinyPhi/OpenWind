-- modules/procurement/seed/001_seed.sql
-- Idempotency guard added (#161) — see modules/crm/seed/001_seed.sql's
-- comment for the full rationale; same pattern applied here.

INSERT INTO entity_types (id, tenant_id, name, plural, icon, module_id, allow_custom_fields)
SELECT gen_random_uuid(), '{TENANT_ID}', 'Purchase Order', 'Purchase Orders', '🛒', '{MODULE_ID}', true
WHERE NOT EXISTS (
  SELECT 1 FROM entity_types WHERE name = 'Purchase Order' AND tenant_id = '{TENANT_ID}'
);

INSERT INTO entity_fields (id, entity_type_id, tenant_id, name, label, field_type, is_required, is_indexed, sort_order, config)
VALUES
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Purchase Order' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'title',         'Title',         'text',     true,  false, 0, '{}'::jsonb),
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Purchase Order' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'vendor',        'Vendor',        'text',     true,  false, 1, '{}'::jsonb),
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Purchase Order' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'amount',        'Total Amount',  'currency', true,  false, 2, '{}'::jsonb),
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Purchase Order' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'category',      'Category',      'enum',     false, false, 3, '{"options":[{"value":"software","label":"Software"},{"value":"hardware","label":"Hardware"},{"value":"services","label":"Services"},{"value":"office","label":"Office Supplies"},{"value":"other","label":"Other"}]}'::jsonb),
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Purchase Order' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'justification', 'Justification', 'longtext', true,  false, 4, '{}'::jsonb),
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Purchase Order' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'required_date', 'Required By',   'date',     false, false, 5, '{}'::jsonb)
ON CONFLICT (entity_type_id, name) DO NOTHING;

-- Idempotency keyed on entity_type_id, not name — see
-- modules/helpdesk/seed/002_workflow.sql's comment (issues #168/#170/#171).
INSERT INTO workflows (id, tenant_id, entity_type_id, name, initial_state)
SELECT gen_random_uuid(), '{TENANT_ID}', (SELECT id FROM entity_types WHERE name = 'Purchase Order' AND tenant_id = '{TENANT_ID}'), '{WORKFLOW_NAME}', 'requested'
WHERE NOT EXISTS (
  SELECT 1 FROM workflows
  WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Purchase Order' AND tenant_id = '{TENANT_ID}')
    AND tenant_id = '{TENANT_ID}'
);

-- Clean up existing states/transitions for this workflow to ensure idempotency
DELETE FROM workflow_transitions WHERE workflow_id = (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Purchase Order' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}');
DELETE FROM workflow_states WHERE workflow_id = (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Purchase Order' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}');

INSERT INTO workflow_states (id, workflow_id, tenant_id, name, label, color, is_terminal, sort_order)
VALUES
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Purchase Order' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'requested',    'Requested',    '#6366f1', false, 0),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Purchase Order' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'under_review', 'Under Review', '#f59e0b', false, 1),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Purchase Order' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'approved',     'Approved',     '#10b981', false, 2),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Purchase Order' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'ordered',      'Ordered',      '#3b82f6', false, 3),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Purchase Order' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'received',     'Received',     '#8b5cf6', true,  4),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Purchase Order' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'rejected',     'Rejected',     '#ef4444', true,  5);

INSERT INTO workflow_transitions (id, workflow_id, tenant_id, from_state, to_state, label, allowed_roles, requires_comment, requires_fields)
VALUES
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Purchase Order' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'requested',    'under_review', 'Start Review',  ARRAY['admin','agent'], false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Purchase Order' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'under_review', 'approved',     'Approve',       ARRAY['admin'],         false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Purchase Order' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'under_review', 'rejected',     'Reject',        ARRAY['admin'],         true,  ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Purchase Order' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'approved',     'ordered',      'Place Order',   ARRAY['admin','agent'], false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Purchase Order' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'ordered',      'received',     'Mark Received', ARRAY['admin','agent'], false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Purchase Order' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'approved',     'rejected',     'Cancel',        ARRAY['admin'],         true,  ARRAY[]::text[]);
