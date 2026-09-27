-- `textarea` was never a registered entity field type. Tender's four
-- multi-line fields used it anyway, causing the entity engine's schema builder
-- to fall back to z.unknown() and accept non-string values. The registered
-- multi-line type is `longtext`.
--
-- The update is intentionally not limited to tender fields: every persisted
-- `textarea` value is invalid for the same reason and should receive the
-- registered equivalent. The predicate makes the migration idempotent.
--
-- Rollback (only if all affected rows originally came from this bug):
--   UPDATE entity_fields SET field_type = 'textarea'
--   WHERE field_type = 'longtext'
--     AND name IN ('summary', 'finance_details', 'eligibility_criteria', 'certifications');

UPDATE entity_fields
SET field_type = 'longtext'
WHERE field_type = 'textarea';
