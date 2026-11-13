-- ============================================================
-- Migration: 0163_oncall_rotation_sweeper_schedule_read
-- #1122 -- docs/specs/oncall-team-rotation.md, ADR-016 addendum A3
-- ============================================================
--
-- DOWN MIGRATION (rollback):
-- REVOKE SELECT (rotation_id, starts_at, deleted_at) ON on_call_schedules FROM oncall_rotation_sweeper;
--
-- The rotation sweeper used to load every active rotation on every tick, because it could not tell
-- which ones had a window close enough to need a notice (a failed notice is retried on the next
-- run, and a just-generated window moves next_starts_at a full cycle ahead). It now selects only
-- rotations that are due OR have a live window starting within the notice lead, and that second
-- test reads three columns of on_call_schedules. Column-level and read-only: no window id, no
-- people, no times beyond starts_at. The existing unique index on (rotation_id, starts_at) serves
-- the lookup, so there is no new index.

GRANT SELECT (rotation_id, starts_at, deleted_at)
  ON on_call_schedules TO oncall_rotation_sweeper;
