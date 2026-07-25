WITH
  et AS (
    INSERT INTO entity_types (id, tenant_id, name, plural, icon, module_id, allow_custom_fields)
    VALUES (gen_random_uuid(), '{TENANT_ID}', 'Deal', 'Deals', '💼', '{MODULE_ID}', true)
    RETURNING id
  ),
  _fields AS (
    INSERT INTO entity_fields (id, entity_type_id, tenant_id, name, label, field_type, is_required, is_indexed, sort_order, config)
    SELECT gen_random_uuid(), et.id, '{TENANT_ID}', 'company',       'Company',       'text',     true,  false, 0, '{}'::jsonb FROM et UNION ALL
    SELECT gen_random_uuid(), et.id, '{TENANT_ID}', 'contact_name',  'Contact Name',  'text',     true,  false, 1, '{}'::jsonb FROM et UNION ALL
    SELECT gen_random_uuid(), et.id, '{TENANT_ID}', 'contact_email', 'Contact Email', 'text',     false, false, 2, '{}'::jsonb FROM et UNION ALL
    SELECT gen_random_uuid(), et.id, '{TENANT_ID}', 'value',         'Deal Value',    'currency', false, false, 3, '{}'::jsonb FROM et UNION ALL
    SELECT gen_random_uuid(), et.id, '{TENANT_ID}', 'source',        'Lead Source',   'enum',     false, false, 4, '{"options":[{"value":"inbound","label":"Inbound"},{"value":"outbound","label":"Outbound"},{"value":"referral","label":"Referral"},{"value":"partner","label":"Partner"}]}'::jsonb FROM et UNION ALL
    SELECT gen_random_uuid(), et.id, '{TENANT_ID}', 'notes',         'Notes',         'longtext', false, false, 5, '{}'::jsonb FROM et
  ),
  wf AS (
    INSERT INTO workflows (id, tenant_id, entity_type_id, name, initial_state)
    SELECT gen_random_uuid(), '{TENANT_ID}', et.id, '{WORKFLOW_NAME}', 'lead' FROM et
    RETURNING id
  ),
  _states AS (
    INSERT INTO workflow_states (id, workflow_id, tenant_id, name, label, color, is_terminal, sort_order)
    SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'lead',        'Lead',        '#6366f1', false, 0 FROM wf UNION ALL
    SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'qualified',   'Qualified',   '#3b82f6', false, 1 FROM wf UNION ALL
    SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'proposal',    'Proposal',    '#f59e0b', false, 2 FROM wf UNION ALL
    SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'negotiation', 'Negotiation', '#8b5cf6', false, 3 FROM wf UNION ALL
    SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'won',         'Won',         '#10b981', true,  4 FROM wf UNION ALL
    SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'lost',        'Lost',        '#ef4444', true,  5 FROM wf
  )
INSERT INTO workflow_transitions (id, workflow_id, tenant_id, from_state, to_state, label, allowed_roles, requires_comment, requires_fields)
SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'lead',        'qualified',   'Qualify',           ARRAY['admin','agent'], false, ARRAY[]::text[] FROM wf UNION ALL
SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'qualified',   'proposal',    'Send Proposal',     ARRAY['admin','agent'], false, ARRAY[]::text[] FROM wf UNION ALL
SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'proposal',    'negotiation', 'Start Negotiation', ARRAY['admin','agent'], false, ARRAY[]::text[] FROM wf UNION ALL
SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'negotiation', 'won',         'Close Won',         ARRAY['admin','agent'], true,  ARRAY[]::text[] FROM wf UNION ALL
SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'negotiation', 'lost',        'Close Lost',        ARRAY['admin','agent'], true,  ARRAY[]::text[] FROM wf UNION ALL
SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'proposal',    'lost',        'Reject Proposal',   ARRAY['admin','agent'], true,  ARRAY[]::text[] FROM wf UNION ALL
SELECT gen_random_uuid(), wf.id, '{TENANT_ID}', 'qualified',   'lost',        'Disqualify',        ARRAY['admin','agent'], true,  ARRAY[]::text[] FROM wf;
