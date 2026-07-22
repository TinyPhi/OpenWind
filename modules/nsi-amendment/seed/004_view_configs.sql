-- modules/nsi-amendment/seed/004_view_configs.sql

INSERT INTO view_configs (id, tenant_id, entity_type_slug, list_columns, detail_layout, form_field_order)
VALUES (
  gen_random_uuid(),
  '{TENANT_ID}',
  'nsi_amendment_request',
  '[
    {"field": "loa_reference_no", "label": "LOA Reference No.", "width": 160, "sortable": true},
    {"field": "item_description", "label": "Item Description", "width": 280, "sortable": false},
    {"field": "sales_owner", "label": "Sales Owner", "width": 150, "sortable": true},
    {"field": "currentState", "label": "Status", "width": 160, "sortable": true},
    {"field": "railway_submission_date", "label": "Submitted On", "width": 140, "sortable": true},
    {"field": "createdAt", "label": "Created At", "width": 180, "sortable": true}
  ]'::jsonb,
  '[
    {"group": "Item Details", "fields": ["loa_reference_no", "railway_zone", "item_description", "quantity", "estimated_price", "justification"]},
    {"group": "Supporting Documents", "fields": ["technical_spec_docs", "product_catalogue", "compliance_docs", "commercial_details_doc"]},
    {"group": "Internal Review", "fields": ["sales_owner", "technical_reviewer", "commercial_reviewer", "management_approver"]},
    {"group": "Railway Submission", "fields": ["amendment_letter", "railway_submission_date", "railway_contact_person", "followup_log", "railway_response"]},
    {"group": "Outcome", "fields": ["amended_loa_document", "rejection_reason"]}
  ]'::jsonb,
  '["loa_reference_no", "railway_zone", "item_description", "quantity", "estimated_price", "justification", "technical_spec_docs", "product_catalogue", "compliance_docs", "commercial_details_doc"]'::jsonb
)
ON CONFLICT (tenant_id, entity_type_slug) DO NOTHING;
