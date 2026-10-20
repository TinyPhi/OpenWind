-- modules/vendor-approval/seed/002_workflow.sql

-- Idempotency keyed on entity_type_id, not name — same reasoning as
-- modules/tender/seed/002_workflow.sql (issues #168, #170).
INSERT INTO workflows (id, tenant_id, entity_type_id, name, initial_state, allow_state_override)
SELECT gen_random_uuid(), '{TENANT_ID}', (SELECT id FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}'), '{WORKFLOW_NAME}', 'draft', true
WHERE NOT EXISTS (
  SELECT 1 FROM workflows
  WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}')
    AND tenant_id = '{TENANT_ID}'
);

DELETE FROM workflow_transitions WHERE workflow_id = (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}');
DELETE FROM workflow_states WHERE workflow_id = (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}');

-- Review states carry a 48h SLA; draft and terminal states carry none.
INSERT INTO workflow_states (id, workflow_id, tenant_id, name, label, color, is_terminal, sla_hours, sort_order)
VALUES
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'draft', 'Draft', '#6b7280', false, NULL, 1),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'it_security_review', 'IT Security Review', '#3b82f6', false, 48, 2),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'legal_review', 'Legal Review', '#8b5cf6', false, 48, 3),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'pending_final_approval', 'Pending Final Approval', '#f59e0b', false, 48, 4),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'approved', 'Approved', '#10b981', true, NULL, 5),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'rejected', 'Rejected', '#ef4444', true, NULL, 6);

-- Each review stage is gated by its department role (Zitadel project roles
-- it_security / legal / finance_approver, held alongside the base agent role) and by
-- segregation of duties (docs/specs/segregation-of-duties.md): the requester cannot
-- decide their own vendor, and nobody decides two stages of the same vendor. There is no
-- blanket admin on the review transitions; an admin unsticks a record with the recorded
-- state override, which this workflow ships switched on (docs/specs/state-override.md).
-- Sequential only — no quorum (#65).
INSERT INTO workflow_transitions (id, workflow_id, tenant_id, from_state, to_state, label, allowed_roles, conditions, requires_comment, requires_fields)
VALUES
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'draft', 'it_security_review', 'Submit for IT Security Review', ARRAY['agent', 'admin']::text[], NULL, false, ARRAY['contact_email', 'annual_spend_estimate', 'business_justification', 'security_questionnaire']::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'it_security_review', 'legal_review', 'Approve Security', ARRAY['it_security']::text[], '{"op": "and", "children": [{"op": "actor_not_creator"}, {"op": "actor_not_prior_actor"}]}'::jsonb, false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'it_security_review', 'rejected', 'Reject (Security)', ARRAY['it_security']::text[], '{"op": "and", "children": [{"op": "actor_not_creator"}, {"op": "actor_not_prior_actor"}]}'::jsonb, true, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'legal_review', 'pending_final_approval', 'Approve Legal', ARRAY['legal']::text[], '{"op": "and", "children": [{"op": "actor_not_creator"}, {"op": "actor_not_prior_actor"}]}'::jsonb, false, ARRAY['contract_draft']::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'legal_review', 'rejected', 'Reject (Legal)', ARRAY['legal']::text[], '{"op": "and", "children": [{"op": "actor_not_creator"}, {"op": "actor_not_prior_actor"}]}'::jsonb, true, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'pending_final_approval', 'approved', 'Approve Vendor', ARRAY['finance_approver']::text[], '{"op": "and", "children": [{"op": "actor_not_creator"}, {"op": "actor_not_prior_actor"}]}'::jsonb, false, ARRAY[]::text[]),
  (gen_random_uuid(), (SELECT id FROM workflows WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}') AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'pending_final_approval', 'rejected', 'Reject (Finance)', ARRAY['finance_approver']::text[], '{"op": "and", "children": [{"op": "actor_not_creator"}, {"op": "actor_not_prior_actor"}]}'::jsonb, true, ARRAY[]::text[]);
