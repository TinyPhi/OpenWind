-- modules/vendor-approval/seed/004_view_configs.sql

INSERT INTO view_configs (id, tenant_id, entity_type_slug, list_columns, detail_layout, form_field_order)
VALUES (
  gen_random_uuid(),
  '{TENANT_ID}',
  'vendor',
  '[
    {"field": "vendor_name", "label": "Vendor", "width": 260, "sortable": true},
    {"field": "category", "label": "Category", "width": 140, "sortable": true},
    {"field": "currentState", "label": "Status", "width": 180, "sortable": true},
    {"field": "annual_spend_estimate", "label": "Annual Spend", "width": 160, "sortable": true},
    {"field": "createdAt", "label": "Created At", "width": 180, "sortable": true}
  ]'::jsonb,
  '[
    {"group": "Vendor", "fields": ["vendor_name", "category", "contact_email"]},
    {"group": "Justification & Spend", "fields": ["business_justification", "annual_spend_estimate"]},
    {"group": "Security", "fields": ["security_questionnaire"]},
    {"group": "Legal", "fields": ["contract_draft"]},
    {"group": "Source", "fields": ["source_system", "external_ref"]}
  ]'::jsonb,
  '["vendor_name", "category", "contact_email", "annual_spend_estimate", "business_justification", "security_questionnaire", "contract_draft", "source_system", "external_ref"]'::jsonb
)
ON CONFLICT (tenant_id, entity_type_slug) DO NOTHING;
