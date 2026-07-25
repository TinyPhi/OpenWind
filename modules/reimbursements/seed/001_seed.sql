WITH
  et AS (
    INSERT INTO entity_types (id, tenant_id, name, plural, icon, module_id, allow_custom_fields)
    VALUES (gen_random_uuid(), '{TENANT_ID}', 'Expense Claim', 'Expense Claims', '💸', '{MODULE_ID}', true)
    RETURNING id
  ),
  _fields AS (
    INSERT INTO entity_fields (id, entity_type_id, tenant_id, name, label, field_type, is_required, is_indexed, sort_order, config)
    SELECT gen_random_uuid(), et.id, '{TENANT_ID}', 'title',        'Title',        'text',     true,  false, 0, '{}'::jsonb FROM et UNION ALL
    SELECT gen_random_uuid(), et.id, '{TENANT_ID}', 'amount',       'Amount',       'currency', true,  false, 1, '{}'::jsonb FROM et UNION ALL
    SELECT gen_random_uuid(), et.id, '{TENANT_ID}', 'category',     'Category',     'enum',     true,  false, 2, '{"options":[{"value":"travel","label":"Travel"},{"value":"meals","label":"Meals"},{"value":"accommodation","label":"Accommodation"},{"value":"equipment","label":"Equipment"},{"value":"other","label":"Other"}]}'::jsonb FROM et UNION ALL
    SELECT gen_random_uuid(), et.id, '{TENANT_ID}', 'expense_date', 'Expense Date', 'date',     true,  false, 3, '{}'::jsonb FROM et UNION ALL
    SELECT gen_random_uuid(), et.id, '{TENANT_ID}', 'description',  'Description',  'longtext', false, false, 4, '{}'::jsonb FROM et UNION ALL
    SELECT gen_random_uuid(), et.id, '{TENANT_ID}', 'receipt',      'Receipt Note', 'text',     false, false, 5, '{}'::jsonb FROM et
  ),
  wf AS (
    INSERT INTO workflows (id, tenant_id, entity_type_id, name, initial_state)
    SELECT gen_random_uuid(), '{TENANT_ID}', et.id, '{WORKFLOW_NAME}', 'draft' FROM et
    RETURNING id
  ),
  _states AS (
    INSERT INTO workflow_states (id, workflow_id, tenant_id, name, label, color, is_terminal, sort_order)
    SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'draft',     'Draft',     '#6b7280', false, 0 FROM wf UNION ALL
    SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'submitted', 'Submitted', '#6366f1', false, 1 FROM wf UNION ALL
    SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'approved',  'Approved',  '#10b981', false, 2 FROM wf UNION ALL
    SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'paid',      'Paid',      '#3b82f6', true,  3 FROM wf UNION ALL
    SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'rejected',  'Rejected',  '#ef4444', true,  4 FROM wf
  )
INSERT INTO workflow_transitions (id, workflow_id, tenant_id, from_state, to_state, label, allowed_roles, requires_comment, requires_fields)
SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'draft',     'submitted', 'Submit',       ARRAY['admin','agent','user'], false, ARRAY[]::text[] FROM wf UNION ALL
SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'submitted', 'approved',  'Approve',      ARRAY['admin'],                false, ARRAY[]::text[] FROM wf UNION ALL
SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'submitted', 'rejected',  'Reject',       ARRAY['admin'],                true,  ARRAY[]::text[] FROM wf UNION ALL
SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'approved',  'paid',      'Mark Paid',    ARRAY['admin'],                false, ARRAY[]::text[] FROM wf UNION ALL
SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'submitted', 'draft',     'Return Draft', ARRAY['admin','user'],         true,  ARRAY[]::text[] FROM wf;
