-- Down migration:
-- ALTER TABLE workflows DROP COLUMN IF EXISTS created_by;

-- Immutable creator reference for the per-workflow admin model. The creator is
-- always an implicit workflow admin (checked in code, not enforced by a FK to
-- assigned_to since assigned_to is a plain array). See
-- docs/specs/workflow-ownership-admin.md.
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS created_by TEXT;

COMMENT ON COLUMN workflows.created_by IS
  'Zitadel user ID of the workflow''s creator. Immutable after insert; always an implicit workflow admin regardless of assigned_to membership.';

-- analytics: excluded (internal assignment metadata, not customer-facing PII)
