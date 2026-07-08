-- analytics: included(created_by, assigned_to) — type change only, same columns as before
-- Down migration:
-- WARNING: these casts will fail if any non-UUID values exist in created_by or assigned_to.
-- Verify first: SELECT count(*) FROM entity_instances WHERE created_by !~ '^[0-9a-f-]{36}$' OR assigned_to !~ '^[0-9a-f-]{36}$';
-- ALTER TABLE "entity_instances" ALTER COLUMN "created_by" TYPE uuid USING "created_by"::uuid;
-- ALTER TABLE "entity_instances" ALTER COLUMN "assigned_to" TYPE uuid USING "assigned_to"::uuid;

ALTER TABLE "entity_instances" ALTER COLUMN "created_by" TYPE text USING "created_by"::text;
ALTER TABLE "entity_instances" ALTER COLUMN "assigned_to" TYPE text USING "assigned_to"::text;