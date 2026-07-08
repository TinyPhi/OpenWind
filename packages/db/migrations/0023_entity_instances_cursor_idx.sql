-- Down migration:
-- DROP INDEX IF EXISTS "entity_instances_cursor_idx";

CREATE INDEX "entity_instances_cursor_idx"
  ON "entity_instances" USING btree ("tenant_id", "entity_type_id", "created_at", "id");
