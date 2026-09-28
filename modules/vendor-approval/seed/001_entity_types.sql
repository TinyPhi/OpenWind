-- modules/vendor-approval/seed/001_entity_types.sql

INSERT INTO entity_types (id, tenant_id, name, plural, icon, module_id, allow_custom_fields)
SELECT gen_random_uuid(), '{TENANT_ID}', 'vendor', 'Vendors', 'building', '{MODULE_ID}', true
WHERE NOT EXISTS (
  SELECT 1 FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}'
);

-- source_system / external_ref identify where a vendor record originated
-- (manual entry, the synthetic payload, or a future real connector — #634),
-- so swapping the source never touches the workflow or rules.
INSERT INTO entity_fields (entity_type_id, tenant_id, name, label, field_type, config, is_required, is_indexed, is_system, sort_order, sensitivity)
VALUES
  ((SELECT id FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'vendor_name', 'Vendor Name', 'text', '{}'::jsonb, true, true, false, 1, 'internal'),
  ((SELECT id FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'category', 'Category', 'select', '{"options": ["software", "services", "hardware", "consulting"]}'::jsonb, true, true, false, 2, 'internal'),
  ((SELECT id FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'contact_email', 'Contact Email', 'text', '{}'::jsonb, false, false, false, 3, 'internal'),
  ((SELECT id FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'annual_spend_estimate', 'Annual Spend Estimate', 'currency', '{}'::jsonb, false, false, false, 4, 'financial'),
  ((SELECT id FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'business_justification', 'Business Justification', 'longtext', '{}'::jsonb, false, false, false, 5, 'internal'),
  ((SELECT id FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'security_questionnaire', 'Security Questionnaire', 'file', '{}'::jsonb, false, false, false, 6, 'internal'),
  ((SELECT id FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'contract_draft', 'Contract Draft', 'file', '{}'::jsonb, false, false, false, 7, 'internal'),
  ((SELECT id FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'source_system', 'Source System', 'text', '{}'::jsonb, false, true, false, 8, 'internal'),
  ((SELECT id FROM entity_types WHERE name = 'vendor' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'external_ref', 'External Reference', 'text', '{}'::jsonb, false, true, false, 9, 'internal')
ON CONFLICT (entity_type_id, name) DO NOTHING;
