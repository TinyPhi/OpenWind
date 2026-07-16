-- analytics: excluded (operational join table, no analytics value)
-- down: ALTER TABLE entity_relations DROP COLUMN deleted_at;
--       DROP INDEX IF EXISTS entity_relations_active_from_idx;
--       DROP INDEX IF EXISTS entity_relations_active_to_idx;

ALTER TABLE entity_relations
  ADD COLUMN deleted_at TIMESTAMPTZ;

-- replace existing indexes with partial indexes covering only active (non-deleted) relations
DROP INDEX IF EXISTS entity_relations_from_idx;
DROP INDEX IF EXISTS entity_relations_to_idx;

CREATE INDEX entity_relations_active_from_idx
  ON entity_relations (tenant_id, from_instance_id)
  WHERE deleted_at IS NULL;

CREATE INDEX entity_relations_active_to_idx
  ON entity_relations (tenant_id, to_instance_id)
  WHERE deleted_at IS NULL;
