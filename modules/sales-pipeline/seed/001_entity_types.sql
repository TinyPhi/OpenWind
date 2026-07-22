-- modules/sales-pipeline/seed/001_entity_types.sql
--
-- Field types follow packages/entity-engine/src/field-types.ts (text,
-- longtext, number, currency, date, enum, user_ref, files) — see the same
-- note in modules/nsi-amendment/seed/001_entity_types.sql. Same ROLE NOTE
-- applies: only agent/admin exist as global roles; Technical/Finance/QA/
-- Management approvals are tracked as named user_ref + enum status fields,
-- not as transition-level roles.

INSERT INTO entity_types (id, tenant_id, name, plural, icon, module_id, allow_custom_fields)
SELECT gen_random_uuid(), '{TENANT_ID}', 'sales_enquiry', 'Sales Enquiries', 'trending-up', '{MODULE_ID}', true
WHERE NOT EXISTS (
  SELECT 1 FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'
);

INSERT INTO entity_fields (entity_type_id, tenant_id, name, label, field_type, config, is_required, is_indexed, is_system, sort_order)
VALUES
  ((SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'customer_name', 'Customer Name', 'text', '{}'::jsonb, true, true, false, 1),
  ((SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'enquiry_source', 'Enquiry Source', 'enum', '{"options":[{"value":"direct","label":"Direct"},{"value":"tender","label":"Tender"},{"value":"referral","label":"Referral"},{"value":"existing_customer","label":"Existing Customer"}]}'::jsonb, true, true, false, 2),
  ((SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'product_service_required', 'Product/Service Required', 'longtext', '{}'::jsonb, true, false, false, 3),
  ((SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'enquiry_date', 'Enquiry Date', 'date', '{}'::jsonb, true, true, false, 4),
  ((SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'assigned_sales_person', 'Assigned Sales Person', 'user_ref', '{}'::jsonb, true, true, false, 5),
  ((SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'expected_closure_date', 'Expected Closure Date', 'date', '{}'::jsonb, false, true, false, 6),
  ((SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'quotation_reference_no', 'Quotation Reference No.', 'text', '{}'::jsonb, false, true, false, 7),
  ((SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'quotation_amount', 'Quotation Amount', 'currency', '{}'::jsonb, false, false, false, 8),
  ((SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'costing_status', 'Costing Status', 'enum', '{"options":[{"value":"not_started","label":"Not Started"},{"value":"in_progress","label":"In Progress"},{"value":"done","label":"Done"}]}'::jsonb, false, true, false, 9),
  ((SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'technical_approver', 'Technical Approver', 'user_ref', '{}'::jsonb, false, false, false, 10),
  ((SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'technical_approval_status', 'Technical Approval Status', 'enum', '{"options":[{"value":"pending","label":"Pending"},{"value":"approved","label":"Approved"},{"value":"rejected","label":"Rejected"}]}'::jsonb, false, false, false, 11),
  ((SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'finance_approver', 'Finance Approver', 'user_ref', '{}'::jsonb, false, false, false, 12),
  ((SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'finance_approval_status', 'Finance Approval Status', 'enum', '{"options":[{"value":"pending","label":"Pending"},{"value":"approved","label":"Approved"},{"value":"rejected","label":"Rejected"}]}'::jsonb, false, false, false, 13),
  ((SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'qa_approver', 'QA Approver', 'user_ref', '{}'::jsonb, false, false, false, 14),
  ((SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'qa_approval_status', 'QA Approval Status', 'enum', '{"options":[{"value":"pending","label":"Pending"},{"value":"approved","label":"Approved"},{"value":"rejected","label":"Rejected"}]}'::jsonb, false, false, false, 15),
  ((SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'management_approver', 'Management Approver', 'user_ref', '{}'::jsonb, false, false, false, 16),
  ((SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'management_approval_status', 'Management Approval Status', 'enum', '{"options":[{"value":"pending","label":"Pending"},{"value":"approved","label":"Approved"},{"value":"rejected","label":"Rejected"}]}'::jsonb, false, false, false, 17),
  ((SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'supporting_documents', 'Supporting Documents', 'files', '{}'::jsonb, false, false, false, 18),
  ((SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'document_expiry_date', 'Document Expiry Date', 'date', '{}'::jsonb, false, true, false, 19),
  ((SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'tender_deadline', 'Tender Deadline', 'date', '{}'::jsonb, false, true, false, 20),
  ((SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'inspection_date', 'Inspection Date', 'date', '{}'::jsonb, false, false, false, 21),
  ((SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'payment_due_date', 'Payment Due Date', 'date', '{}'::jsonb, false, true, false, 22),
  ((SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'customer_response_log', 'Customer Response Log', 'longtext', '{}'::jsonb, false, false, false, 23),
  ((SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'order_value', 'Order Value', 'currency', '{}'::jsonb, false, false, false, 24),
  ((SELECT id FROM entity_types WHERE name = 'sales_enquiry' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'next_action_remarks', 'Next Action / Remarks', 'longtext', '{}'::jsonb, false, false, false, 25)
ON CONFLICT (entity_type_id, name) DO NOTHING;
