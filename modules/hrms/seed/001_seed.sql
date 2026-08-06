-- modules/hrms/seed/001_seed.sql
-- Idempotency guard added (#161) — see modules/crm/seed/001_seed.sql's
-- comment for the full rationale; same pattern applied here.

INSERT INTO entity_types (id, tenant_id, name, plural, icon, module_id, allow_custom_fields)
SELECT gen_random_uuid(), '{TENANT_ID}', 'Leave Request', 'Leave Requests', '🏖️', '{MODULE_ID}', true
WHERE NOT EXISTS (
  SELECT 1 FROM entity_types WHERE name = 'Leave Request' AND tenant_id = '{TENANT_ID}'
);

INSERT INTO entity_fields (id, entity_type_id, tenant_id, name, label, field_type, is_required, is_indexed, sort_order, config)
VALUES
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Leave Request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'employee_name', 'Employee Name', 'text',     true,  false, 0, '{}'::jsonb),
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Leave Request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'leave_type',   'Leave Type',    'enum',     true,  false, 1, '{"options":[{"value":"annual","label":"Annual Leave"},{"value":"sick","label":"Sick Leave"},{"value":"unpaid","label":"Unpaid Leave"},{"value":"maternity","label":"Maternity/Paternity"}]}'::jsonb),
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Leave Request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'start_date',   'Start Date',    'date',     true,  false, 2, '{}'::jsonb),
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Leave Request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'end_date',     'End Date',      'date',     true,  false, 3, '{}'::jsonb),
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Leave Request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'days',         'Number of Days','number',   false, false, 4, '{}'::jsonb),
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Leave Request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'reason',       'Reason',        'longtext', false, false, 5, '{}'::jsonb)
ON CONFLICT (entity_type_id, name) DO NOTHING;

-- Idempotency keyed on entity_type_id, not name — see
-- modules/helpdesk/seed/002_workflow.sql's comment (issues #168/#170/#171).
INSERT INTO workflows (id, tenant_id, entity_type_id, name, initial_state)
SELECT gen_random_uuid(), '{TENANT_ID}', (SELECT id FROM entity_types WHERE name = 'Leave Request' AND tenant_id = '{TENANT_ID}'), '{WORKFLOW_NAME}', 'submitted'
WHERE NOT EXISTS (
  SELECT 1 FROM workflows
  WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Leave Request' AND tenant_id = '{TENANT_ID}')
    AND tenant_id = '{TENANT_ID}'
);

-- Clean up existing states/transitions for this workflow to ensure idempotency
DELETE FROM workflow_transitions WHERE workflow_id = (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Leave Request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}');
DELETE FROM workflow_states WHERE workflow_id = (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Leave Request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}');

INSERT INTO workflow_states (id, workflow_id, tenant_id, name, label, color, is_terminal, sort_order)
VALUES
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Leave Request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'submitted',    'Submitted',   '#6366f1', false, 0),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Leave Request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'under_review', 'Under Review','#f59e0b', false, 1),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Leave Request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'approved',     'Approved',    '#10b981', true,  2),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Leave Request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'rejected',     'Rejected',    '#ef4444', true,  3),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Leave Request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'cancelled',    'Cancelled',   '#6b7280', true,  4);

INSERT INTO workflow_transitions (id, workflow_id, tenant_id, from_state, to_state, label, allowed_roles, requires_comment, requires_fields)
VALUES
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Leave Request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'submitted',    'under_review', 'Start Review', ARRAY['admin','agent'], false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Leave Request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'under_review', 'approved',     'Approve',      ARRAY['admin'],         false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Leave Request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'under_review', 'rejected',     'Reject',       ARRAY['admin'],         true,  ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Leave Request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'submitted',    'cancelled',    'Cancel',       ARRAY['admin','user'],  false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Leave Request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'under_review', 'cancelled',    'Cancel',       ARRAY['admin','user'],  true,  ARRAY[]::text[]);
