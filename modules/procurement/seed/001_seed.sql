WITH
  et AS (
    INSERT INTO entity_types (id, tenant_id, name, plural, icon, module_id, allow_custom_fields)
    VALUES (gen_random_uuid(), '{TENANT_ID}', 'Purchase Order', 'Purchase Orders', '🛒', '{MODULE_ID}', true)
    RETURNING id
  ),
  _fields AS (
    INSERT INTO entity_fields (id, entity_type_id, tenant_id, name, label, field_type, is_required, is_indexed, sort_order, config)
    SELECT gen_random_uuid(), et.id, '{TENANT_ID}', 'title',         'Title',         'text',     true,  false, 0, '{}'::jsonb FROM et UNION ALL
    SELECT gen_random_uuid(), et.id, '{TENANT_ID}', 'vendor',        'Vendor',        'text',     true,  false, 1, '{}'::jsonb FROM et UNION ALL
    SELECT gen_random_uuid(), et.id, '{TENANT_ID}', 'amount',        'Total Amount',  'currency', true,  false, 2, '{}'::jsonb FROM et UNION ALL
    SELECT gen_random_uuid(), et.id, '{TENANT_ID}', 'category',      'Category',      'enum',     false, false, 3, '{"options":[{"value":"software","label":"Software"},{"value":"hardware","label":"Hardware"},{"value":"services","label":"Services"},{"value":"office","label":"Office Supplies"},{"value":"other","label":"Other"}]}'::jsonb FROM et UNION ALL
    SELECT gen_random_uuid(), et.id, '{TENANT_ID}', 'justification', 'Justification', 'longtext', true,  false, 4, '{}'::jsonb FROM et UNION ALL
    SELECT gen_random_uuid(), et.id, '{TENANT_ID}', 'required_date', 'Required By',   'date',     false, false, 5, '{}'::jsonb FROM et
  ),
  wf AS (
    INSERT INTO workflows (id, tenant_id, entity_type_id, name, initial_state)
    SELECT gen_random_uuid(), '{TENANT_ID}', et.id, '{WORKFLOW_NAME}', 'requested' FROM et
    RETURNING id
  ),
  _states AS (
    INSERT INTO workflow_states (id, workflow_id, tenant_id, name, label, color, is_terminal, sort_order)
    SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'requested',   'Requested',    '#6366f1', false, 0 FROM wf UNION ALL
    SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'under_review', 'Under Review', '#f59e0b', false, 1 FROM wf UNION ALL
    SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'approved',    'Approved',     '#10b981', false, 2 FROM wf UNION ALL
    SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'ordered',     'Ordered',      '#3b82f6', false, 3 FROM wf UNION ALL
    SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'received',    'Received',     '#8b5cf6', true,  4 FROM wf UNION ALL
    SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'rejected',    'Rejected',     '#ef4444', true,  5 FROM wf
  )
INSERT INTO workflow_transitions (id, workflow_id, tenant_id, from_state, to_state, label, allowed_roles, requires_comment, requires_fields)
SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'requested',    'under_review', 'Start Review',  ARRAY['admin','agent'], false, ARRAY[]::text[] FROM wf UNION ALL
SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'under_review', 'approved',     'Approve',       ARRAY['admin'],         false, ARRAY[]::text[] FROM wf UNION ALL
SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'under_review', 'rejected',     'Reject',        ARRAY['admin'],         true,  ARRAY[]::text[] FROM wf UNION ALL
SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'approved',     'ordered',      'Place Order',   ARRAY['admin','agent'], false, ARRAY[]::text[] FROM wf UNION ALL
SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'ordered',      'received',     'Mark Received', ARRAY['admin','agent'], false, ARRAY[]::text[] FROM wf UNION ALL
SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'approved',     'rejected',     'Cancel',        ARRAY['admin'],         true,  ARRAY[]::text[] FROM wf;
