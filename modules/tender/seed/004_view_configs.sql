-- modules/tender/seed/004_view_configs.sql

-- Tender layout
INSERT INTO view_configs (id, tenant_id, entity_type_slug, list_columns, detail_layout, form_field_order)
VALUES (
  gen_random_uuid(),
  '{TENANT_ID}',
  'tender',
  '[
    {"field": "title", "label": "Title", "width": 280, "sortable": true},
    {"field": "client_name", "label": "Client", "width": 200, "sortable": true},
    {"field": "currentState", "label": "Status", "width": 160, "sortable": true},
    {"field": "submitted_at", "label": "Submitted At", "width": 180, "sortable": true},
    {"field": "createdAt", "label": "Created At", "width": 180, "sortable": true}
  ]'::jsonb,
  '[
    {"group": "Overview", "fields": ["title", "client_name", "summary"]},
    {"group": "Financial & Eligibility", "fields": ["finance_details", "eligibility_criteria", "certifications"]},
    {"group": "BOQ & Costing", "fields": ["boq_file", "costing_child_id"]},
    {"group": "Documents & Submission", "fields": ["tender_documents", "submitted_at", "submitted_by"]}
  ]'::jsonb,
  '["title", "client_name", "summary", "finance_details", "eligibility_criteria", "certifications", "boq_file", "tender_documents"]'::jsonb
)
ON CONFLICT (tenant_id, entity_type_slug) DO NOTHING;
