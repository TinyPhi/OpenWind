-- modules/helpdesk/seed/002_workflow.sql

-- Insert workflow record. {WORKFLOW_NAME} resolves to the module's catalog
-- display name at install time — see apps/api/src/services/module-service.ts.
-- Every other lookup of this workflow in this file keys on entity_type_id,
-- NOT name, so the display name can be safely customized afterward.
INSERT INTO workflows (id, tenant_id, entity_type_id, name, initial_state)
SELECT gen_random_uuid(), '{TENANT_ID}', (SELECT id FROM entity_types WHERE name = 'ticket' AND tenant_id = '{TENANT_ID}'), '{WORKFLOW_NAME}', 'open'
WHERE NOT EXISTS (
  SELECT 1 FROM workflows
  WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'ticket' AND tenant_id = '{TENANT_ID}')
);

-- Clean up existing states/transitions for this workflow to ensure idempotency
DELETE FROM workflow_transitions WHERE workflow_id = (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'ticket' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}');
DELETE FROM workflow_states WHERE workflow_id = (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'ticket' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}');

-- Insert workflow states
INSERT INTO workflow_states (id, workflow_id, name, label, color, is_terminal, sla_hours, sort_order)
VALUES
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'ticket' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'open', 'Open', '#888780', false, NULL, 1),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'ticket' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'in_progress', 'In Progress', '#007bff', false, NULL, 2),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'ticket' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'pending', 'Pending', '#ffc107', false, NULL, 3),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'ticket' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'resolved', 'Resolved', '#28a745', true, NULL, 4);

-- Insert workflow transitions
INSERT INTO workflow_transitions (id, workflow_id, from_state, to_state, label, allowed_roles, conditions, requires_comment, requires_fields)
VALUES
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'ticket' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'open', 'in_progress', 'Start Working', ARRAY['admin', 'agent']::text[], NULL, false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'ticket' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'in_progress', 'pending', 'Wait for Customer', ARRAY['admin', 'agent']::text[], NULL, true, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'ticket' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'pending', 'in_progress', 'Resume Work', ARRAY['admin', 'agent']::text[], NULL, false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'ticket' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'in_progress', 'resolved', 'Resolve Ticket', ARRAY['admin', 'agent']::text[], NULL, true, ARRAY[]::text[]);
