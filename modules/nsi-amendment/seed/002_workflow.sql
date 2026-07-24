-- modules/nsi-amendment/seed/002_workflow.sql

-- {WORKFLOW_NAME} resolves to the module's catalog display name at install
-- time — see apps/api/src/services/module-service.ts. Every other lookup of
-- this workflow in this file keys on entity_type_id, NOT name, so the display
-- name can be safely customized without breaking seed-time lookups.
INSERT INTO workflows (id, tenant_id, entity_type_id, name, initial_state)
SELECT gen_random_uuid(), '{TENANT_ID}', (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}'), '{WORKFLOW_NAME}', 'draft'
WHERE NOT EXISTS (
  SELECT 1 FROM workflows
  WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}')
);

-- Clean up existing states/transitions for this workflow to ensure idempotency
DELETE FROM workflow_transitions WHERE workflow_id = (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}');
DELETE FROM workflow_states WHERE workflow_id = (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}');

-- sla_hours: Documents Pending = 72h (3 days), Awaiting Railway Response = 168h
-- (7 days) — placeholders per the design doc, not yet client-confirmed.
INSERT INTO workflow_states (id, workflow_id, name, label, color, is_terminal, sla_hours, sort_order)
VALUES
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'draft', 'Draft', '#6b7280', false, NULL, 1),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'internal_review', 'Internal Review', '#3b82f6', false, NULL, 2),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'documents_pending', 'Documents Pending', '#f59e0b', false, 72, 3),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'ready_for_submission', 'Ready for Submission', '#8b5cf6', false, NULL, 4),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'submitted_to_railway', 'Submitted to Railway', '#0ea5e9', false, NULL, 5),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'awaiting_railway_response', 'Awaiting Railway Response', '#eab308', false, 168, 6),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'clarification_requested', 'Clarification Requested', '#f97316', false, NULL, 7),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'approved', 'Approved', '#059669', true, NULL, 8),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'rejected', 'Rejected', '#dc2626', true, NULL, 9),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'withdrawn', 'Withdrawn', '#71717a', true, NULL, 10);

-- allowed_roles: only agent/admin exist as global roles on this platform (see
-- 001_entity_types.sql's ROLE NOTE) — Technical/Commercial/Management/Sales
-- distinctions are carried by the user_ref fields, not by transition roles.
INSERT INTO workflow_transitions (id, workflow_id, from_state, to_state, label, allowed_roles, conditions, requires_comment, requires_fields)
VALUES
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'draft', 'internal_review', 'Send for Internal Review', ARRAY['agent', 'admin']::text[], NULL, false, ARRAY['loa_reference_no', 'item_description', 'quantity', 'estimated_price', 'justification']::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'internal_review', 'documents_pending', 'Flag Missing Documents', ARRAY['agent', 'admin']::text[], NULL, true, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'documents_pending', 'internal_review', 'Documents Uploaded', ARRAY['agent', 'admin']::text[], NULL, false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'internal_review', 'ready_for_submission', 'Approve for Submission', ARRAY['agent', 'admin']::text[], NULL, false, ARRAY['technical_reviewer', 'commercial_reviewer', 'management_approver']::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'ready_for_submission', 'submitted_to_railway', 'Submit to Railway', ARRAY['agent', 'admin']::text[], NULL, false, ARRAY['amendment_letter', 'railway_submission_date']::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'submitted_to_railway', 'awaiting_railway_response', 'Awaiting Response', ARRAY['agent', 'admin']::text[], NULL, false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'awaiting_railway_response', 'clarification_requested', 'Railway Requested Clarification', ARRAY['agent', 'admin']::text[], NULL, true, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'clarification_requested', 'internal_review', 'Re-review with New Info', ARRAY['agent', 'admin']::text[], NULL, false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'awaiting_railway_response', 'approved', 'Mark Approved', ARRAY['agent', 'admin']::text[], NULL, false, ARRAY['amended_loa_document']::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'awaiting_railway_response', 'rejected', 'Mark Rejected', ARRAY['agent', 'admin']::text[], NULL, false, ARRAY['rejection_reason']::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'draft', 'withdrawn', 'Withdraw Request', ARRAY['agent', 'admin']::text[], NULL, true, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'internal_review', 'withdrawn', 'Withdraw Request', ARRAY['agent', 'admin']::text[], NULL, true, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), 'documents_pending', 'withdrawn', 'Withdraw Request', ARRAY['agent', 'admin']::text[], NULL, true, ARRAY[]::text[]);
