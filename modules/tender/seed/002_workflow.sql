-- modules/tender/seed/002_workflow.sql

-- Insert workflow record
-- Idempotency keyed on entity_type_id, not name: a tenant may rename this
-- workflow after install (installModule's workflowName option), and
-- workflows(tenant_id, entity_type_id) is UNIQUE (migration 0036, issue #168)
-- — keying on the literal seed name would attempt a second INSERT for the
-- same entity type after a rename and hit that constraint.
-- Name is seeded via {WORKFLOW_NAME} (the module's registry display name),
-- not a hardcoded literal — issue #170: a hardcoded name meant
-- installModule's workflowName rename option could never find this row via
-- its exact-name match, since seed SQL and the rename lookup used different
-- strings.
INSERT INTO workflows (id, tenant_id, entity_type_id, name, initial_state)
SELECT gen_random_uuid(), '{TENANT_ID}', (SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}'), '{WORKFLOW_NAME}', 'draft'
WHERE NOT EXISTS (
  SELECT 1 FROM workflows
  WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}')
    AND tenant_id = '{TENANT_ID}'
);

-- Clean up existing states/transitions for this workflow to ensure idempotency
DELETE FROM workflow_transitions WHERE workflow_id = (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}');
DELETE FROM workflow_states WHERE workflow_id = (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}');

-- Insert workflow states
INSERT INTO workflow_states (id, workflow_id, tenant_id, name, label, color, is_terminal, sla_hours, sort_order)
VALUES
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'draft', 'Draft', '#6b7280', false, NULL, 1),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'boq_preparation', 'BOQ Preparation', '#3b82f6', false, NULL, 2),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'pending_costing_review', 'Pending Costing Review', '#f59e0b', false, NULL, 3),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'costing_approved', 'Costing Approved', '#10b981', false, NULL, 4),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'document_preparation', 'Document Preparation', '#8b5cf6', false, NULL, 5),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'pending_submission_review', 'Pending Submission Review', '#f59e0b', false, NULL, 6),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'submitted', 'Submitted', '#059669', true, NULL, 7);

-- Insert workflow transitions
INSERT INTO workflow_transitions (id, workflow_id, tenant_id, from_state, to_state, label, allowed_roles, conditions, requires_comment, requires_fields)
VALUES
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'draft', 'boq_preparation', 'Start BOQ Preparation', ARRAY['agent', 'admin']::text[], NULL, false, ARRAY['summary', 'finance_details', 'eligibility_criteria', 'certifications']::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'boq_preparation', 'pending_costing_review', 'Submit for Costing Review', ARRAY['agent', 'admin']::text[], NULL, false, ARRAY['boq_file']::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'pending_costing_review', 'costing_approved', 'Approve Costing', ARRAY['agent', 'admin']::text[], NULL, true, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'pending_costing_review', 'boq_preparation', 'Reject Costing', ARRAY['agent', 'admin']::text[], NULL, true, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'costing_approved', 'document_preparation', 'Start Document Preparation', ARRAY['agent', 'admin']::text[], NULL, false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'document_preparation', 'pending_submission_review', 'Submit for Review', ARRAY['agent', 'admin']::text[], NULL, false, ARRAY['tender_documents']::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'pending_submission_review', 'submitted', 'Submit Tender', ARRAY['agent', 'admin']::text[], NULL, false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'pending_submission_review', 'document_preparation', 'Reject to Document Preparation', ARRAY['agent', 'admin']::text[], NULL, true, ARRAY[]::text[]);
