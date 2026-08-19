-- Migration: 0067_replay_uuid_validation_dead_letter_events
-- analytics: excluded
--
-- Replays outbox_events that were dead-lettered due to UUID validation failures on user ID fields
-- before PR #414 relaxed the schema constraint.
--
-- For each matching row in dead_letter_events, we set the corresponding outbox_events row's
-- delivered_at to NULL so the outbox poller claims and processes it again (now with relaxed schemas).
-- Then we delete the dead-lettered record to keep the DLQ clean.
--
-- DOWN MIGRATION:
-- (none - data recovery is a one-way replay operation, no-op to rollback)

WITH replayed AS (
  UPDATE outbox_events
  SET delivered_at = NULL
  FROM dead_letter_events
  WHERE outbox_events.id = dead_letter_events.original_event_id
    AND dead_letter_events.event_type IN ('entity.created', 'entity.assigned', 'entity.updated', 'workflow.transitioned', 'entity.unassigned')
    AND dead_letter_events.error ILIKE '%uuid%'
  RETURNING dead_letter_events.id
)
DELETE FROM dead_letter_events
WHERE id IN (SELECT id FROM replayed);
