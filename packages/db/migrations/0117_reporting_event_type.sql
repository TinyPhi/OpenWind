-- Give reporting the one thing it needs from the event payload, so the payload
-- itself can stop being granted.
--
-- Every reporting dataset that touches workflow_events.metadata reads exactly
-- one key out of it and nothing else:
--
--     my_tickets_assigned    metadata->>'type' = 'comment'
--     my_tickets_created     metadata->>'type' = 'comment'
--     ticket_first_response  metadata->>'type' = 'comment'
--     ticket_list            metadata->>'type' = 'comment'
--     ticket_dwell_time      COALESCE(metadata->>'type','transition') <> 'comment'
--
-- That single key is the whole reason the reporting role can currently read a
-- column that holds actor names, attached filenames and per-field values marked
-- pii or financial. Promoting it to a column of its own removes the reason, and
-- migration 0118 then withdraws the payload.
--
-- Why a plain column and a trigger, not GENERATED ALWAYS AS ... STORED. Adding a
-- stored generated column rewrites the table under ACCESS EXCLUSIVE, and
-- workflow_events is append-heavy — that is an outage on a real deployment.
-- Virtual generated columns would avoid the rewrite but arrived in PostgreSQL
-- 18; this platform runs 16. A nullable column is a catalogue-only change and
-- takes no rewrite, and the trigger keeps it honest.
--
-- Why a trigger rather than computing it in the engine. A database-level trigger
-- cannot be bypassed by a future writer, and this value is a security boundary
-- now: if it drifts from the payload, a chart silently miscounts and nobody can
-- see why. The application is not changed by this migration.
--
-- NULL means the key is absent, which is how the existing SQL already treats it.
-- ticket_dwell_time's COALESCE(..., 'transition') keeps working unchanged.
--
-- Rollback (undoes only what THIS migration adds):
--   DROP TRIGGER IF EXISTS workflow_events_set_event_type ON workflow_events;
--   DROP FUNCTION IF EXISTS set_workflow_event_type();
--   ALTER TABLE workflow_events DROP COLUMN IF EXISTS event_type;

BEGIN;

-- ── 1. The column ───────────────────────────────────────────────────────────
-- Nullable with no default, so this is a catalogue change: no table rewrite and
-- no exclusive lock held while existing rows are read.
ALTER TABLE workflow_events
    ADD COLUMN IF NOT EXISTS event_type text;

COMMENT ON COLUMN workflow_events.event_type IS
    'Derived mirror of metadata->>''type''. Maintained by trigger. Exists so '
    'reporting can classify events without being granted the raw payload '
    '(docs/specs/reporting-metadata-masking-repair.md).';

-- ── 2. Keep it honest on every write ────────────────────────────────────────
-- Fires on UPDATE as well as INSERT: an edit to metadata must not be able to
-- leave a stale classification behind. Recomputed rather than defaulted, so
-- there is no path that sets it to a value disagreeing with the payload.
CREATE OR REPLACE FUNCTION set_workflow_event_type()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.event_type := NEW.metadata->>'type';
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS workflow_events_set_event_type ON workflow_events;
CREATE TRIGGER workflow_events_set_event_type
    BEFORE INSERT OR UPDATE ON workflow_events
    FOR EACH ROW
    EXECUTE FUNCTION set_workflow_event_type();

-- ── 3. Backfill existing rows ───────────────────────────────────────────────
-- Batched rather than one statement, so the write set stays bounded on a large
-- table. UPDATE takes row locks only, never ACCESS EXCLUSIVE, so readers are not
-- blocked either way — the batching bounds transaction size and replication lag,
-- not lock scope.
--
-- Idempotent and re-runnable: the predicate only selects rows that actually
-- disagree, so a second run does nothing. A row where the key is absent has NULL
-- on both sides, which IS DISTINCT FROM treats as equal, so it is never picked
-- up and the loop always terminates.
DO $$
DECLARE
    touched integer;
BEGIN
    LOOP
        UPDATE workflow_events
           SET event_type = metadata->>'type'
         WHERE id IN (
             SELECT id
               FROM workflow_events
              WHERE event_type IS DISTINCT FROM (metadata->>'type')
              LIMIT 5000
         );
        GET DIAGNOSTICS touched = ROW_COUNT;
        EXIT WHEN touched = 0;
    END LOOP;
END
$$;

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
-- Expect 0. Any other number means the backfill or the trigger did not cover
-- something, and migration 0118 must not run until it does.
--
--   SELECT count(*) FROM workflow_events
--    WHERE event_type IS DISTINCT FROM (metadata->>'type');
--
-- Note on grants: analytics_user currently holds a table-level SELECT on
-- workflow_events (the defect 0118 repairs), so it can already read this new
-- column. That is deliberate for now — the datasets are repointed onto
-- event_type BEFORE the payload is withdrawn, so there is no window where a
-- chart is broken.
