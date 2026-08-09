-- down:
--   ALTER TABLE entity_instances DROP COLUMN IF EXISTS due_date;

-- System-level due date, independent of workflow state/SLA (docs/specs/due-date.md).
-- Nullable so existing rows read back NULL and are backfillable by ticket-access
-- users/admins; never reset by workflow transitions (unlike SLA, which is
-- state-derived and ephemeral — see workflow_states.sla_hours).
ALTER TABLE entity_instances
  ADD COLUMN IF NOT EXISTS due_date TIMESTAMPTZ;
