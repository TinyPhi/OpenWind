-- modules/invoicing/seed/001_seed.sql
-- Idempotency guard added (#161) — see modules/crm/seed/001_seed.sql's
-- comment for the full rationale; same pattern applied here.

INSERT INTO entity_types (id, tenant_id, name, plural, icon, module_id, allow_custom_fields)
SELECT gen_random_uuid(), '{TENANT_ID}', 'Invoice', 'Invoices', '🧾', '{MODULE_ID}', true
WHERE NOT EXISTS (
  SELECT 1 FROM entity_types WHERE name = 'Invoice' AND tenant_id = '{TENANT_ID}'
);

INSERT INTO entity_fields (id, entity_type_id, tenant_id, name, label, field_type, is_required, is_indexed, sort_order, config)
VALUES
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Invoice' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'invoice_number', 'Invoice #',    'text',     true,  false, 0, '{}'::jsonb),
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Invoice' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'client_name',   'Client Name',  'text',     true,  false, 1, '{}'::jsonb),
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Invoice' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'client_email',  'Client Email', 'text',     false, false, 2, '{}'::jsonb),
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Invoice' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'amount',        'Amount',       'currency', true,  false, 3, '{}'::jsonb),
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Invoice' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'due_date',      'Due Date',     'date',     true,  false, 4, '{}'::jsonb),
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Invoice' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'description',   'Description',  'longtext', false, false, 5, '{}'::jsonb)
ON CONFLICT (entity_type_id, name) DO NOTHING;

-- Idempotency keyed on entity_type_id, not name — see
-- modules/helpdesk/seed/002_workflow.sql's comment (issues #168/#170/#171).
INSERT INTO workflows (id, tenant_id, entity_type_id, name, initial_state)
SELECT gen_random_uuid(), '{TENANT_ID}', (SELECT id FROM entity_types WHERE name = 'Invoice' AND tenant_id = '{TENANT_ID}'), '{WORKFLOW_NAME}', 'draft'
WHERE NOT EXISTS (
  SELECT 1 FROM workflows
  WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Invoice' AND tenant_id = '{TENANT_ID}')
    AND tenant_id = '{TENANT_ID}'
);

-- Clean up existing states/transitions for this workflow to ensure idempotency
DELETE FROM workflow_transitions WHERE workflow_id = (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Invoice' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}');
DELETE FROM workflow_states WHERE workflow_id = (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Invoice' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}');

INSERT INTO workflow_states (id, workflow_id, tenant_id, name, label, color, is_terminal, sort_order)
VALUES
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Invoice' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'draft',     'Draft',     '#6b7280', false, 0),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Invoice' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'sent',      'Sent',      '#3b82f6', false, 1),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Invoice' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'viewed',    'Viewed',    '#8b5cf6', false, 2),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Invoice' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'paid',      'Paid',      '#10b981', true,  3),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Invoice' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'overdue',   'Overdue',   '#ef4444', false, 4),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Invoice' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'cancelled', 'Cancelled', '#6b7280', true,  5);

INSERT INTO workflow_transitions (id, workflow_id, tenant_id, from_state, to_state, label, allowed_roles, requires_comment, requires_fields)
VALUES
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Invoice' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'draft',   'sent',      'Send Invoice',   ARRAY['admin','agent'], false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Invoice' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'sent',    'viewed',    'Mark Viewed',    ARRAY['admin','agent'], false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Invoice' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'sent',    'paid',      'Record Payment', ARRAY['admin','agent'], false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Invoice' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'viewed',  'paid',      'Record Payment', ARRAY['admin','agent'], false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Invoice' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'sent',    'overdue',   'Mark Overdue',   ARRAY['admin','agent'], false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Invoice' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'viewed',  'overdue',   'Mark Overdue',   ARRAY['admin','agent'], false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Invoice' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'overdue', 'paid',      'Record Payment', ARRAY['admin','agent'], false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Invoice' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'draft',   'cancelled', 'Cancel',         ARRAY['admin','agent'], false, ARRAY[]::text[]);
