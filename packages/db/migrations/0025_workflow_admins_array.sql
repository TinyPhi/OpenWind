-- analytics: excluded (operational config, no analytics value)
-- down: ALTER TABLE workflows ALTER COLUMN assigned_to TYPE text USING assigned_to[1];

ALTER TABLE workflows
  ALTER COLUMN assigned_to TYPE text[]
  USING CASE WHEN assigned_to IS NULL THEN NULL ELSE ARRAY[assigned_to] END;
