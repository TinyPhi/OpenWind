-- analytics: excluded (data fix on existing entity_fields rows only -- no new table)
--
-- docs/specs/mandatory-ticket-fields.md R1/R2. Every workflow's title is required and
-- protected: is_system=true means it can't be renamed, made optional or deleted (ADR-004
-- CF-01). Until now only the helpdesk seed protected it; every other module's title, and the
-- title auto-created for workflows built in the UI, could be made optional or deleted. The
-- seeds and the auto-created title are fixed in the same change; this brings existing tenants
-- in line. Re-running a seed never changes an existing row (ON CONFLICT DO NOTHING).
--
-- Also marks tender's engine-written submitted_at/submitted_by `"readOnly": true`. The record
-- view now shows protected fields (it used to hide every is_system field, which hid the
-- helpdesk ticket's title); readOnly keeps these two out of the edit form.
--
-- Entity types that have no title field at all (and records with no title value) are left
-- to the backfill in PR 2 (spec R9), which adds field and values together.
--
-- DOWN MIGRATION:
--   Not reversible row-for-row: which titles were optional or unprotected before is not
--   recorded. To undo the readOnly flag only:
--   UPDATE entity_fields ef SET config = ef.config - 'readOnly'
--   FROM entity_types et JOIN modules m ON m.id = et.module_id
--   WHERE ef.entity_type_id = et.id AND m.slug = 'tender' AND et.name = 'tender'
--     AND ef.name IN ('submitted_at', 'submitted_by');

UPDATE entity_fields
SET is_system = true,
    is_required = true
WHERE name = 'title'
  AND tenant_id IS NOT NULL
  AND (is_system = false OR is_required = false);

UPDATE entity_fields ef
SET config = ef.config || '{"readOnly": true}'::jsonb
FROM entity_types et
JOIN modules m ON m.id = et.module_id
WHERE ef.entity_type_id = et.id
  AND m.slug = 'tender'
  AND et.name = 'tender'
  AND ef.name IN ('submitted_at', 'submitted_by')
  AND NOT coalesce((ef.config ->> 'readOnly')::boolean, false);
