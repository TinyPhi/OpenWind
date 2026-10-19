-- analytics: excluded (index only -- no new table)
--
-- The retention sweep (apps/worker/src/retention-sweep.ts, docs/specs/retention-classes.md) deletes
-- workflow_events rows with `tenant_id = $1 AND created_at < now() - interval`, in batches. The
-- only tenant-leading index is (tenant_id, instance_id), so every batch scanned the tenant's whole
-- event history to find the old rows. This index serves that predicate and any other
-- "events for a tenant in a time range" read.
--
-- DOWN MIGRATION:
--   DROP INDEX IF EXISTS "workflow_events_tenant_created_at_idx";

CREATE INDEX IF NOT EXISTS "workflow_events_tenant_created_at_idx"
  ON "workflow_events" ("tenant_id", "created_at");
