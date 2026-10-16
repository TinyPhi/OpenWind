-- modules/tender/seed/001_entity_types.sql

-- Insert entity type idempotently
INSERT INTO entity_types (id, tenant_id, name, plural, icon, module_id, allow_custom_fields)
SELECT gen_random_uuid(), '{TENANT_ID}', 'tender', 'Tenders', 'tender', '{MODULE_ID}', true
WHERE NOT EXISTS (
  SELECT 1 FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}'
);

-- Insert fields for Tender
-- sensitivity defaults to 'internal' at the column level; finance_details is
-- explicitly tagged 'financial' per spec R7/§V so workflow_events.metadata
-- redaction picks it up.
--
-- is_system=true means protected: it can't be renamed, made optional or deleted
-- (ADR-004 CF-01). It does not hide a field. title is protected on every workflow
-- (docs/specs/mandatory-ticket-fields.md R1). submitted_at/submitted_by are engine-written,
-- so they are also `"readOnly": true`: the record view shows them as text, never as inputs.
-- Every other field is business data the admin may change, so is_system=false.
INSERT INTO entity_fields (entity_type_id, tenant_id, name, label, field_type, config, is_required, is_indexed, is_system, sort_order, sensitivity)
VALUES
  ((SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'title', 'Title', 'text', '{}'::jsonb, true, true, true, 1, 'internal'),
  ((SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'client_name', 'Client Name', 'text', '{}'::jsonb, true, true, false, 2, 'internal'),
  ((SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'summary', 'Summary', 'longtext', '{}'::jsonb, false, false, false, 3, 'internal'),
  ((SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'finance_details', 'Finance Details', 'longtext', '{}'::jsonb, false, false, false, 4, 'financial'),
  ((SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'eligibility_criteria', 'Eligibility Criteria', 'longtext', '{}'::jsonb, false, false, false, 5, 'internal'),
  ((SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'certifications', 'Certifications', 'longtext', '{}'::jsonb, false, false, false, 6, 'internal'),
  ((SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'boq_file', 'BOQ File', 'file', '{}'::jsonb, false, false, false, 7, 'internal'),
  ((SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'costing_child_id', 'Costing Child Ticket', 'entity_ref', '{"target_entity_type": "tender"}'::jsonb, false, true, false, 8, 'internal'),
  ((SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'tender_documents', 'Tender Documents', 'file', '{}'::jsonb, false, false, false, 9, 'internal'),
  ((SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'submitted_at', 'Submitted At', 'datetime', '{"readOnly": true}'::jsonb, false, false, true, 10, 'internal'),
  ((SELECT id FROM entity_types WHERE name = 'tender' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'submitted_by', 'Submitted By', 'user_ref', '{"readOnly": true}'::jsonb, false, false, true, 11, 'internal')
ON CONFLICT (entity_type_id, name) DO NOTHING;
