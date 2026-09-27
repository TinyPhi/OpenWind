-- `textarea` was never a registered entity field type. Tender and Helpdesk
-- seeds used it for multi-line fields, causing the entity engine's schema
-- builder to fall back to z.unknown() and accept non-string values. The
-- registered multi-line type is `longtext`.
--
-- The update is intentionally not limited to tender fields: every persisted
-- `textarea` value is invalid for the same reason and should receive the
-- registered equivalent. The predicate makes the migration idempotent.
--
-- There is no safe automatic rollback: after this migration, invalid legacy
-- rows and legitimate longtext rows are intentionally indistinguishable. Any
-- rollback must identify the exact pre-migration rows from a backup or audit
-- record before changing them back to `textarea`.

UPDATE entity_fields
SET field_type = 'longtext'
WHERE field_type = 'textarea';
