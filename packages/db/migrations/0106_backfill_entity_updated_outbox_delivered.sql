-- analytics: excluded (data-fix migration, no schema change)
-- down: irreversible -- there is no way to recover which of these rows were
-- already-delivered vs. newly-marked once this runs; not designed to be rolled back.

-- PR #600 review (Vijit), B2 -- this PR is the first one to add `entityTypeId`
-- and `changed` to the entity.updated outbox payload (packages/entity-engine/src/
-- engine.ts) and the first to add entity.updated to the poller's processed event
-- types (apps/worker/src/outbox-poller.ts). Every entity.updated row written
-- before this PR lacks those two fields. Once this PR ships and the poller
-- restarts, it will dequeue those old undelivered rows, fail
-- TriggerEventSchema.safeParse() on the missing required fields, throw
-- AutomationError("INVALID_EVENT_PAYLOAD"), and retry them forever (the poller
-- only advances delivered_at on success). These old rows were never intended to
-- be processed -- the poller didn't consume entity.updated at all until this PR --
-- so they're marked delivered here rather than reprocessed.
UPDATE outbox_events
SET delivered_at = now()
WHERE event_type = 'entity.updated'
  AND delivered_at IS NULL;
