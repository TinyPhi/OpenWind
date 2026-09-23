-- Give reporting the two form values it needs, so the form itself can stop
-- being granted.
--
-- Same defect and same remedy as workflow_events.metadata (0117/0118), applied
-- to the larger table. ADR-001 says analytics_user gets entity_instances "All
-- columns **except `fields`**", because the form payload may hold raw PII.
-- Migration 0113 line 55 granted the table wholesale, which handed `fields`
-- back along with everything added since.
--
-- What reporting actually reads out of the payload, confirmed across every
-- dataset definition — two keys, nothing else:
--
--     fields->>'title'        the ticket title shown in list and detail tiles
--     fields->>'department'   a grouping dimension
--
-- Named `reporting_*` rather than `title`/`department` on purpose. A bare
-- `title` column on this table would imply every entity instance has one, and
-- they do not: `title` is defined on three entity types and `department` on
-- one, both as tenant-configurable form fields. The prefix says what these are
-- — a projection maintained for reporting — and keeps the namespace free for a
-- real column should the platform ever grow one.
--
-- Exact mirrors, deliberately. `apps/api/src/routes/reporting/query.ts` builds
-- a friendlier title with COALESCE over 'title'/'subject'/'name' and an id
-- fallback, but that path runs as app_user and is untouched here. Copying its
-- fallbacks into this column would make the Superset datasets return different
-- rows than they do today, and the whole point is that they return identical
-- ones. Equivalence is verified before the payload grant is withdrawn in 0122.
--
-- Mechanism follows 0117: a nullable column is a catalogue-only change with no
-- table rewrite, where a stored generated column would rewrite this table under
-- an exclusive lock. Virtual generated columns are PostgreSQL 18; this runs 16.
--
-- Rollback (undoes only what THIS migration adds):
--   DROP TRIGGER IF EXISTS entity_instances_set_reporting_projections ON entity_instances;
--   DROP FUNCTION IF EXISTS set_entity_instance_reporting_projections();
--   ALTER TABLE entity_instances DROP COLUMN IF EXISTS reporting_title;
--   ALTER TABLE entity_instances DROP COLUMN IF EXISTS reporting_department;

BEGIN;

-- ── 1. The columns ──────────────────────────────────────────────────────────
ALTER TABLE entity_instances
    ADD COLUMN IF NOT EXISTS reporting_title text,
    ADD COLUMN IF NOT EXISTS reporting_department text;

COMMENT ON COLUMN entity_instances.reporting_title IS
    'Derived mirror of fields->>''title''. Maintained by trigger. Exists so '
    'reporting can name a ticket without being granted the form payload '
    '(docs/specs/reporting-metadata-masking-repair.md).';

COMMENT ON COLUMN entity_instances.reporting_department IS
    'Derived mirror of fields->>''department''. Maintained by trigger. Exists '
    'so reporting can group by department without being granted the form '
    'payload (docs/specs/reporting-metadata-masking-repair.md).';

-- ── 2. Keep them honest on every write ──────────────────────────────────────
-- On UPDATE as well as INSERT: editing the form must not leave a stale
-- projection behind. Recomputed rather than defaulted, so nothing can set them
-- to a value that disagrees with the payload.
CREATE OR REPLACE FUNCTION set_entity_instance_reporting_projections()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.reporting_title      := NEW.fields->>'title';
    NEW.reporting_department := NEW.fields->>'department';
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS entity_instances_set_reporting_projections ON entity_instances;
CREATE TRIGGER entity_instances_set_reporting_projections
    BEFORE INSERT OR UPDATE ON entity_instances
    FOR EACH ROW
    EXECUTE FUNCTION set_entity_instance_reporting_projections();

-- ── 3. Backfill ─────────────────────────────────────────────────────────────
-- Batched to bound transaction size on a large table. UPDATE takes row locks
-- only, never ACCESS EXCLUSIVE, so readers are never blocked.
--
-- Idempotent: the predicate selects only rows that actually disagree, and a row
-- where a key is absent is NULL on both sides, which IS DISTINCT FROM treats as
-- equal. So a second run does nothing and the loop always terminates.
DO $$
DECLARE
    touched integer;
BEGIN
    LOOP
        UPDATE entity_instances
           SET reporting_title      = fields->>'title',
               reporting_department = fields->>'department'
         WHERE id IN (
             SELECT id
               FROM entity_instances
              WHERE reporting_title      IS DISTINCT FROM (fields->>'title')
                 OR reporting_department IS DISTINCT FROM (fields->>'department')
              LIMIT 5000
         );
        GET DIAGNOSTICS touched = ROW_COUNT;
        EXIT WHEN touched = 0;
    END LOOP;
END
$$;

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
-- Expect 0. Any other number means 0122 must not run yet.
--
--   SELECT count(*) FROM entity_instances
--    WHERE reporting_title      IS DISTINCT FROM (fields->>'title')
--       OR reporting_department IS DISTINCT FROM (fields->>'department');
--
-- Note on grants: analytics_user still holds a table-level SELECT here (the
-- defect 0122 repairs), so it can already read these new columns. That is
-- deliberate — the datasets are repointed onto them BEFORE the payload is
-- withdrawn, so no chart is ever broken in between.
