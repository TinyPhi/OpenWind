-- Make ticket priority available to reporting.
--
-- Priority is the field people actually filter on — "show me the high priority
-- tickets due this week" is the question the reporting page exists to answer —
-- and Superset has never been able to ask it. The ticket datasets expose a
-- `severity` column that is a hardcoded `'Not set'::text` literal, so it reads
-- as a real dimension, offers itself in every filter dropdown, and answers
-- every question with one value. Priority itself was never exposed at all.
--
-- The real values are there and well populated:
--
--     low 88, urgent 79, high 74, medium 59, empty 6
--
-- They live in the form payload, which reporting is no longer granted (0122).
-- So this follows 0121 exactly: a derived column, maintained by the trigger
-- that already keeps title and department honest, and the payload stays shut.
--
-- Exact mirror again, including the empty string six rows carry. Normalising
-- here would bake a presentation choice into the data and make the column
-- disagree with the payload it claims to mirror; the datasets do the tidy-up,
-- the same way they already humanise `current_state`.
--
-- This migration extends the existing trigger function rather than adding a
-- second trigger. One function covering all three projections means they cannot
-- drift apart, and there is one place to look when a fourth is needed.
--
-- Rollback (undoes only what THIS migration adds — the trigger function reverts
-- to the two-column form from 0121):
--   ALTER TABLE entity_instances DROP COLUMN IF EXISTS reporting_priority;
--   -- then re-create set_entity_instance_reporting_projections() without the
--   -- reporting_priority assignment, as 0121 defines it.

BEGIN;

-- ── 1. The column ───────────────────────────────────────────────────────────
ALTER TABLE entity_instances
    ADD COLUMN IF NOT EXISTS reporting_priority text;

COMMENT ON COLUMN entity_instances.reporting_priority IS
    'Derived mirror of fields->>''priority''. Maintained by trigger. Exists so '
    'reporting can filter and group by priority without being granted the form '
    'payload (docs/specs/reporting-metadata-masking-repair.md).';

-- ── 2. Extend the existing projection trigger ───────────────────────────────
-- Replaces the 0121 definition. Same trigger, same firing conditions; it now
-- maintains three columns instead of two.
CREATE OR REPLACE FUNCTION set_entity_instance_reporting_projections()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.reporting_title      := NEW.fields->>'title';
    NEW.reporting_department := NEW.fields->>'department';
    NEW.reporting_priority   := NEW.fields->>'priority';
    RETURN NEW;
END
$$;

-- ── 3. Backfill ─────────────────────────────────────────────────────────────
-- Batched and idempotent, on the same reasoning as 0121: row locks only, and a
-- predicate that selects nothing once the column agrees with the payload.
DO $$
DECLARE
    touched integer;
BEGIN
    LOOP
        UPDATE entity_instances
           SET reporting_priority = fields->>'priority'
         WHERE id IN (
             SELECT id
               FROM entity_instances
              WHERE reporting_priority IS DISTINCT FROM (fields->>'priority')
              LIMIT 5000
         );
        GET DIAGNOSTICS touched = ROW_COUNT;
        EXIT WHEN touched = 0;
    END LOOP;
END
$$;

-- ── 4. Grant it ─────────────────────────────────────────────────────────────
-- Column-level, added to the allowlist 0122 established. A new column on this
-- table is unreadable by reporting until someone grants it deliberately, and
-- this is that deliberate step.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_user') THEN
        EXECUTE 'GRANT SELECT (reporting_priority) ON entity_instances '
                'TO analytics_user';
    END IF;
END
$$;

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
-- Expect 0.
--
--   SELECT count(*) FROM entity_instances
--    WHERE reporting_priority IS DISTINCT FROM (fields->>'priority');
--
-- Expect the real distribution, not a single value:
--
--   SET ROLE analytics_user;
--   SET app.tenant_id = '<a real tenant>';
--   SELECT reporting_priority, count(*) FROM entity_instances GROUP BY 1;
