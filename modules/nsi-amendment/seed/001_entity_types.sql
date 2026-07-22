-- modules/nsi-amendment/seed/001_entity_types.sql
--
-- Field types follow packages/entity-engine/src/field-types.ts (text, longtext,
-- number, currency, date, datetime, enum, user_ref, entity_ref, file, files) —
-- not the "textarea"/"select" names used in the plain-English design doc.
--
-- ROLE NOTE: this platform only has two global roles, agent/admin (see
-- modules/tender/seed/003_automation_rules.sql's ROLE NOTE) — there is no
-- per-department "Technical"/"Commercial"/"Management" role. Those
-- stakeholders are tracked here as named user_ref fields (technical_reviewer,
-- commercial_reviewer, management_approver) that any agent/admin can fill in
-- and act on, not as distinct workflow_transitions.allowed_roles values.

INSERT INTO entity_types (id, tenant_id, name, plural, icon, module_id, allow_custom_fields)
SELECT gen_random_uuid(), '{TENANT_ID}', 'nsi_amendment_request', 'NSI Amendment Requests', 'file-plus', '{MODULE_ID}', true
WHERE NOT EXISTS (
  SELECT 1 FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}'
);

INSERT INTO entity_fields (entity_type_id, tenant_id, name, label, field_type, config, is_required, is_indexed, is_system, sort_order)
VALUES
  ((SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'loa_reference_no', 'LOA Reference No.', 'text', '{}'::jsonb, true, true, false, 1),
  ((SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'railway_zone', 'Railway Zone/Division', 'enum', '{"options":[{"value":"northern","label":"Northern"},{"value":"southern","label":"Southern"},{"value":"eastern","label":"Eastern"},{"value":"western","label":"Western"},{"value":"central","label":"Central"},{"value":"north_eastern","label":"North Eastern"},{"value":"north_western","label":"North Western"},{"value":"south_central","label":"South Central"},{"value":"south_eastern","label":"South Eastern"},{"value":"south_western","label":"South Western"},{"value":"east_central","label":"East Central"},{"value":"east_coast","label":"East Coast"},{"value":"west_central","label":"West Central"},{"value":"north_central","label":"North Central"}]}'::jsonb, false, true, false, 2),
  ((SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'item_description', 'Item Description', 'longtext', '{}'::jsonb, true, false, false, 3),
  ((SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'quantity', 'Quantity', 'number', '{}'::jsonb, true, false, false, 4),
  ((SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'estimated_price', 'Estimated Price', 'currency', '{}'::jsonb, true, false, false, 5),
  ((SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'justification', 'Justification', 'longtext', '{}'::jsonb, true, false, false, 6),
  ((SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'technical_spec_docs', 'Technical Spec Docs', 'files', '{}'::jsonb, false, false, false, 7),
  ((SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'product_catalogue', 'Product Catalogue', 'files', '{}'::jsonb, false, false, false, 8),
  ((SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'compliance_docs', 'Compliance Docs', 'files', '{}'::jsonb, false, false, false, 9),
  ((SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'commercial_details_doc', 'Commercial Details Doc', 'files', '{}'::jsonb, false, false, false, 10),
  ((SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'sales_owner', 'Assigned Sales Owner', 'user_ref', '{}'::jsonb, true, true, false, 11),
  ((SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'technical_reviewer', 'Technical Reviewer', 'user_ref', '{}'::jsonb, false, true, false, 12),
  ((SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'commercial_reviewer', 'Commercial Reviewer', 'user_ref', '{}'::jsonb, false, true, false, 13),
  ((SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'management_approver', 'Management Approver', 'user_ref', '{}'::jsonb, false, true, false, 14),
  ((SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'amendment_letter', 'Amendment Request Letter', 'file', '{}'::jsonb, false, false, false, 15),
  ((SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'railway_submission_date', 'Railway Submission Date', 'date', '{}'::jsonb, false, false, false, 16),
  ((SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'railway_contact_person', 'Railway Contact Person', 'text', '{}'::jsonb, false, false, false, 17),
  ((SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'followup_log', 'Follow-up Log', 'longtext', '{}'::jsonb, false, false, false, 18),
  ((SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'railway_response', 'Railway Response / Clarification Requested', 'longtext', '{}'::jsonb, false, false, false, 19),
  ((SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'amended_loa_document', 'Amended LOA Document', 'file', '{}'::jsonb, false, false, false, 20),
  ((SELECT id FROM entity_types WHERE name = 'nsi_amendment_request' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'rejection_reason', 'Rejection Reason', 'longtext', '{}'::jsonb, false, false, false, 21)
ON CONFLICT (entity_type_id, name) DO NOTHING;
