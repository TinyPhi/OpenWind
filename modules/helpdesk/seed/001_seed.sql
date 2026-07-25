WITH
  et AS (
    INSERT INTO entity_types (id, tenant_id, name, plural, icon, module_id, allow_custom_fields)
    VALUES (gen_random_uuid(), '{TENANT_ID}', 'Support Ticket', 'Support Tickets', '🎫', '{MODULE_ID}', true)
    RETURNING id
  ),
  _fields AS (
    INSERT INTO entity_fields (id, entity_type_id, tenant_id, name, label, field_type, is_required, is_indexed, sort_order, config)
    SELECT gen_random_uuid(), et.id, '{TENANT_ID}', 'subject',        'Subject',        'text',     true,  true,  0, '{}'::jsonb FROM et UNION ALL
    SELECT gen_random_uuid(), et.id, '{TENANT_ID}', 'description',    'Description',    'longtext', false, false, 1, '{}'::jsonb FROM et UNION ALL
    SELECT gen_random_uuid(), et.id, '{TENANT_ID}', 'priority',       'Priority',       'enum',     true,  false, 2, '{"options":[{"value":"low","label":"Low","color":"#6b7280"},{"value":"medium","label":"Medium","color":"#f59e0b"},{"value":"high","label":"High","color":"#ef4444"},{"value":"urgent","label":"Urgent","color":"#dc2626"}]}'::jsonb FROM et UNION ALL
    SELECT gen_random_uuid(), et.id, '{TENANT_ID}', 'category',       'Category',       'enum',     false, false, 3, '{"options":[{"value":"billing","label":"Billing"},{"value":"technical","label":"Technical"},{"value":"general","label":"General"},{"value":"feature_request","label":"Feature Request"}]}'::jsonb FROM et UNION ALL
    SELECT gen_random_uuid(), et.id, '{TENANT_ID}', 'customer_name',  'Customer Name',  'text',     true,  false, 4, '{}'::jsonb FROM et UNION ALL
    SELECT gen_random_uuid(), et.id, '{TENANT_ID}', 'customer_email', 'Customer Email', 'text',     false, false, 5, '{}'::jsonb FROM et
  ),
  wf AS (
    INSERT INTO workflows (id, tenant_id, entity_type_id, name, initial_state)
    SELECT gen_random_uuid(), '{TENANT_ID}', et.id, '{WORKFLOW_NAME}', 'new' FROM et
    RETURNING id
  ),
  _states AS (
    INSERT INTO workflow_states (id, workflow_id, tenant_id, name, label, color, is_terminal, sort_order)
    SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'new',                  'New',                  '#6366f1', false, 0 FROM wf UNION ALL
    SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'open',                 'Open',                 '#3b82f6', false, 1 FROM wf UNION ALL
    SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'in_progress',          'In Progress',          '#f59e0b', false, 2 FROM wf UNION ALL
    SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'waiting_for_customer', 'Waiting for Customer', '#8b5cf6', false, 3 FROM wf UNION ALL
    SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'resolved',             'Resolved',             '#10b981', false, 4 FROM wf UNION ALL
    SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'closed',               'Closed',               '#6b7280', true,  5 FROM wf
  )
INSERT INTO workflow_transitions (id, workflow_id, tenant_id, from_state, to_state, label, allowed_roles, requires_comment, requires_fields)
SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'new',                  'open',                 'Assign',         ARRAY['admin','agent'],        false, ARRAY[]::text[] FROM wf UNION ALL
SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'open',                 'in_progress',          'Start Working',  ARRAY['admin','agent'],        false, ARRAY[]::text[] FROM wf UNION ALL
SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'in_progress',          'waiting_for_customer', 'Need More Info', ARRAY['admin','agent'],        true,  ARRAY[]::text[] FROM wf UNION ALL
SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'waiting_for_customer', 'in_progress',          'Responded',      ARRAY['admin','agent','user'], false, ARRAY[]::text[] FROM wf UNION ALL
SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'in_progress',          'resolved',             'Mark Resolved',  ARRAY['admin','agent'],        true,  ARRAY[]::text[] FROM wf UNION ALL
SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'resolved',             'closed',               'Close Ticket',   ARRAY['admin','agent','user'], false, ARRAY[]::text[] FROM wf UNION ALL
SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'resolved',             'in_progress',          'Reopen',         ARRAY['admin','agent','user'], true,  ARRAY[]::text[] FROM wf UNION ALL
SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'open',                 'resolved',             'Quick Resolve',  ARRAY['admin','agent'],        true,  ARRAY[]::text[] FROM wf;
