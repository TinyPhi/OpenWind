-- Down migration:
-- ALTER TABLE workflows DROP COLUMN IF EXISTS assigned_to;

ALTER TABLE workflows ADD COLUMN IF NOT EXISTS assigned_to TEXT;

COMMENT ON COLUMN workflows.assigned_to IS
  'Zitadel user ID of the user designated as workflow admin. NULL = unassigned.';

-- analytics: excluded (internal assignment metadata, not customer-facing PII)
