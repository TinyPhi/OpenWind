-- modules/reimbursements/seed/001_seed.sql
-- Idempotency guard added (#161) — see modules/crm/seed/001_seed.sql's
-- comment for the full rationale; same pattern applied here.

INSERT INTO entity_types (id, tenant_id, name, plural, icon, module_id, allow_custom_fields)
SELECT gen_random_uuid(), '{TENANT_ID}', 'Expense Claim', 'Expense Claims', '💸', '{MODULE_ID}', true
WHERE NOT EXISTS (
  SELECT 1 FROM entity_types WHERE name = 'Expense Claim' AND tenant_id = '{TENANT_ID}'
);

INSERT INTO entity_fields (id, entity_type_id, tenant_id, name, label, field_type, is_required, is_indexed, sort_order, config)
VALUES
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Expense Claim' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'title',        'Title',        'text',     true,  false, 0, '{}'::jsonb),
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Expense Claim' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'amount',       'Amount',       'currency', true,  false, 1, '{}'::jsonb),
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Expense Claim' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'category',     'Category',     'enum',     true,  false, 2, '{"options":[{"value":"travel","label":"Travel"},{"value":"meals","label":"Meals"},{"value":"accommodation","label":"Accommodation"},{"value":"equipment","label":"Equipment"},{"value":"other","label":"Other"}]}'::jsonb),
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Expense Claim' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'expense_date', 'Expense Date', 'date',     true,  false, 3, '{}'::jsonb),
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Expense Claim' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'description',  'Description',  'longtext', false, false, 4, '{}'::jsonb),
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Expense Claim' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'receipt',      'Receipt Note', 'text',     false, false, 5, '{}'::jsonb)
ON CONFLICT (entity_type_id, name) DO NOTHING;

-- Idempotency keyed on entity_type_id, not name — see
-- modules/helpdesk/seed/002_workflow.sql's comment (issues #168/#170/#171).
INSERT INTO workflows (id, tenant_id, entity_type_id, name, initial_state)
SELECT gen_random_uuid(), '{TENANT_ID}', (SELECT id FROM entity_types WHERE name = 'Expense Claim' AND tenant_id = '{TENANT_ID}'), '{WORKFLOW_NAME}', 'draft'
WHERE NOT EXISTS (
  SELECT 1 FROM workflows
  WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Expense Claim' AND tenant_id = '{TENANT_ID}')
    AND tenant_id = '{TENANT_ID}'
);

-- Clean up existing states/transitions for this workflow to ensure idempotency
DELETE FROM workflow_transitions WHERE workflow_id = (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Expense Claim' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}');
DELETE FROM workflow_states WHERE workflow_id = (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Expense Claim' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}');

INSERT INTO workflow_states (id, workflow_id, tenant_id, name, label, color, is_terminal, sort_order)
VALUES
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Expense Claim' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'draft',     'Draft',     '#6b7280', false, 0),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Expense Claim' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'submitted', 'Submitted', '#6366f1', false, 1),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Expense Claim' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'approved',  'Approved',  '#10b981', false, 2),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Expense Claim' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'paid',      'Paid',      '#3b82f6', true,  3),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Expense Claim' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'rejected',  'Rejected',  '#ef4444', true,  4);

INSERT INTO workflow_transitions (id, workflow_id, tenant_id, from_state, to_state, label, allowed_roles, requires_comment, requires_fields)
VALUES
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Expense Claim' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'draft',     'submitted', 'Submit',       ARRAY['admin','agent','user'], false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Expense Claim' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'submitted', 'approved',  'Approve',      ARRAY['admin'],                false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Expense Claim' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'submitted', 'rejected',  'Reject',       ARRAY['admin'],                true,  ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Expense Claim' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'approved',  'paid',      'Mark Paid',    ARRAY['admin'],                false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Expense Claim' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'submitted', 'draft',     'Return Draft', ARRAY['admin','user'],         true,  ARRAY[]::text[]);
