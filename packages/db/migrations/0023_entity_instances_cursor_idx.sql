-- Down migration:
-- DROP INDEX IF EXISTS "entity_instances_cursor_idx";

-- IF NOT EXISTS guards a renumbering artifact: this migration was originally
-- 0003 and already applied under that number on any deployment predating the
-- 0019-0031 renumbering, so drizzle's position-based tracking re-runs it here.
CREATE INDEX IF NOT EXISTS "entity_instances_cursor_idx"
  ON "entity_instances" USING btree ("tenant_id", "entity_type_id", "created_at", "id");
