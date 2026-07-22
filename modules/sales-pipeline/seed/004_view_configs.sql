-- modules/sales-pipeline/seed/004_view_configs.sql

INSERT INTO view_configs (id, tenant_id, entity_type_slug, list_columns, detail_layout, form_field_order)
VALUES (
  gen_random_uuid(),
  '{TENANT_ID}',
  'sales_enquiry',
  '[
    {"field": "customer_name", "label": "Customer", "width": 200, "sortable": true},
    {"field": "enquiry_source", "label": "Source", "width": 120, "sortable": true},
    {"field": "assigned_sales_person", "label": "Sales Person", "width": 150, "sortable": true},
    {"field": "currentState", "label": "Stage", "width": 180, "sortable": true},
    {"field": "quotation_amount", "label": "Quotation Amount", "width": 150, "sortable": true},
    {"field": "expected_closure_date", "label": "Expected Closure", "width": 150, "sortable": true},
    {"field": "createdAt", "label": "Created At", "width": 180, "sortable": true}
  ]'::jsonb,
  '[
    {"group": "Enquiry Details", "fields": ["customer_name", "enquiry_source", "product_service_required", "enquiry_date", "assigned_sales_person", "expected_closure_date"]},
    {"group": "Costing & Quotation", "fields": ["costing_status", "quotation_reference_no", "quotation_amount"]},
    {"group": "Approvals", "fields": ["technical_approver", "technical_approval_status", "finance_approver", "finance_approval_status", "qa_approver", "qa_approval_status", "management_approver", "management_approval_status"]},
    {"group": "Documents & Deadlines", "fields": ["supporting_documents", "document_expiry_date", "tender_deadline", "inspection_date", "payment_due_date"]},
    {"group": "Customer & Outcome", "fields": ["customer_response_log", "order_value", "next_action_remarks"]}
  ]'::jsonb,
  '["customer_name", "enquiry_source", "product_service_required", "enquiry_date", "assigned_sales_person", "expected_closure_date"]'::jsonb
)
ON CONFLICT (tenant_id, entity_type_slug) DO NOTHING;
