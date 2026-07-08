-- Down migration:
-- DROP TRIGGER IF EXISTS entity_instances_search_vector_trig ON entity_instances;
-- DROP FUNCTION IF EXISTS entity_instances_search_vector_update();
-- DROP INDEX IF EXISTS entity_instances_search_idx;
-- ALTER TABLE "entity_instances" DROP COLUMN "search_vector";

ALTER TABLE "entity_instances"
  ADD COLUMN "search_vector" tsvector;

CREATE INDEX "entity_instances_search_idx"
  ON "entity_instances" USING gin(search_vector);

-- Note: 'english' dictionary is hardcoded for stemming. Non-English text still
-- gets indexed but stemming quality is reduced. Tracked as future improvement
-- (configurable per-tenant dictionary before GA).
CREATE OR REPLACE FUNCTION entity_instances_search_vector_update()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector(
    'english',
    COALESCE(
      (
        SELECT string_agg(value, ' ')
        FROM jsonb_each_text(NEW.fields)
        WHERE value IS NOT NULL AND trim(value) <> ''
      ),
      ''
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER entity_instances_search_vector_trig
  BEFORE INSERT OR UPDATE OF fields ON entity_instances
  FOR EACH ROW EXECUTE FUNCTION entity_instances_search_vector_update();

-- Backfill existing rows (locks are row-level; no table lock expected at pilot scale).
-- On large tenants this may be slow — run during a maintenance window pre-GA.
UPDATE entity_instances
SET search_vector = to_tsvector(
  'english',
  COALESCE(
    (
      SELECT string_agg(value, ' ')
      FROM jsonb_each_text(fields)
      WHERE value IS NOT NULL AND trim(value) <> ''
    ),
    ''
  )
);
