-- modules/crm/seed/001_seed.sql
-- Idempotency guard added (#161): the previous single CTE-chained INSERT had
-- no WHERE NOT EXISTS/ON CONFLICT anywhere, so retrying installModule after a
-- partial failure silently duplicated entity_types/entity_fields/workflows
-- rows for the tenant. Rewritten to helpdesk's multi-statement idempotent
-- pattern (modules/helpdesk/seed/001_entity_types.sql, 002_workflow.sql).

INSERT INTO entity_types (id, tenant_id, name, plural, icon, module_id, allow_custom_fields)
SELECT gen_random_uuid(), '{TENANT_ID}', 'Deal', 'Deals', '💼', '{MODULE_ID}', true
WHERE NOT EXISTS (
  SELECT 1 FROM entity_types WHERE name = 'Deal' AND tenant_id = '{TENANT_ID}'
);

INSERT INTO entity_fields (id, entity_type_id, tenant_id, name, label, field_type, is_required, is_indexed, sort_order, config)
VALUES
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Deal' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'company',       'Company',       'text',     true,  false, 0, '{}'::jsonb),
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Deal' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'contact_name',  'Contact Name',  'text',     true,  false, 1, '{}'::jsonb),
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Deal' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'contact_email', 'Contact Email', 'text',     false, false, 2, '{}'::jsonb),
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Deal' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'value',         'Deal Value',    'currency', false, false, 3, '{}'::jsonb),
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Deal' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'source',        'Lead Source',   'enum',     false, false, 4, '{"options":[{"value":"inbound","label":"Inbound"},{"value":"outbound","label":"Outbound"},{"value":"referral","label":"Referral"},{"value":"partner","label":"Partner"}]}'::jsonb),
  (gen_random_uuid(), (SELECT id FROM entity_types WHERE name = 'Deal' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'notes',         'Notes',         'longtext', false, false, 5, '{}'::jsonb)
ON CONFLICT (entity_type_id, name) DO NOTHING;

-- Idempotency keyed on entity_type_id, not name — see
-- modules/helpdesk/seed/002_workflow.sql's comment (issues #168/#170/#171):
-- a tenant may rename this workflow post-install, and workflows(tenant_id,
-- entity_type_id) is UNIQUE, so keying on the literal seed name would
-- attempt a second INSERT for the same entity type after a rename.
INSERT INTO workflows (id, tenant_id, entity_type_id, name, initial_state)
SELECT gen_random_uuid(), '{TENANT_ID}', (SELECT id FROM entity_types WHERE name = 'Deal' AND tenant_id = '{TENANT_ID}'), '{WORKFLOW_NAME}', 'lead'
WHERE NOT EXISTS (
  SELECT 1 FROM workflows
  WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Deal' AND tenant_id = '{TENANT_ID}')
    AND tenant_id = '{TENANT_ID}'
);

-- Clean up existing states/transitions for this workflow to ensure idempotency
DELETE FROM workflow_transitions WHERE workflow_id = (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Deal' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}');
DELETE FROM workflow_states WHERE workflow_id = (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Deal' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}');

INSERT INTO workflow_states (id, workflow_id, tenant_id, name, label, color, is_terminal, sort_order)
VALUES
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Deal' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'lead',        'Lead',        '#6366f1', false, 0),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Deal' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'qualified',   'Qualified',   '#3b82f6', false, 1),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Deal' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'proposal',    'Proposal',    '#f59e0b', false, 2),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Deal' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'negotiation', 'Negotiation', '#8b5cf6', false, 3),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Deal' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'won',         'Won',         '#10b981', true,  4),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Deal' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'lost',        'Lost',        '#ef4444', true,  5);

INSERT INTO workflow_transitions (id, workflow_id, tenant_id, from_state, to_state, label, allowed_roles, requires_comment, requires_fields)
VALUES
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Deal' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'lead',        'qualified',   'Qualify',           ARRAY['admin','agent'], false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Deal' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'qualified',   'proposal',    'Send Proposal',     ARRAY['admin','agent'], false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Deal' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'proposal',    'negotiation', 'Start Negotiation', ARRAY['admin','agent'], false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Deal' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'negotiation', 'won',         'Close Won',         ARRAY['admin','agent'], true,  ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Deal' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'negotiation', 'lost',        'Close Lost',        ARRAY['admin','agent'], true,  ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Deal' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'proposal',    'lost',        'Reject Proposal',   ARRAY['admin','agent'], true,  ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Deal' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'qualified',   'lost',        'Disqualify',        ARRAY['admin','agent'], true,  ARRAY[]::text[]);
