-- Migration: 0110_schedule_rules_template_key_rename_backfill
-- analytics: excluded (data backfill only -- no schema change, no new analytics surface)
--
-- PR #659 review (Vijit), B1: the schedule-rules "mandate fields" work
-- (docs/specs/schedule-rules-mandate-fields.md) renamed three template
-- JSONB keys -- assignee_id -> assignedTo, team_id -> teamId,
-- due_after_days -> due_days -- and added two new required keys
-- (due_days, remark). TemplateSchema.parse(rule.template) runs at fire
-- time (apps/worker/src/schedule-tick-worker.ts); any schedule_rules row
-- still carrying the OLD key names would fail that parse forever --
-- silently, with no ticket created and no visible error to the tenant.
--
-- Not applicable in practice: schedule_rules' write path (the
-- /admin/schedule-rules routes and admin UI, 3F Phases 2-4) had not yet
-- merged to main before this same PR -- only the bare tables (3F Phase 1,
-- migrations 0101-0103) existed, with no way to create a row through any
-- product surface. There is no tenant that could have written the old key
-- shape. This migration is included anyway as the required belt-and-
-- suspenders the review asked for, and is a safe no-op wherever the old
-- keys are absent.
--
-- DOWN MIGRATION:
-- This backfill is not meaningfully reversible (the old key names carried
-- no additional information the new ones don't also carry -- due_days'
-- new upper bound of 3650 is more restrictive than due_after_days' same
-- bound, and due_days is a straight value copy). A rollback would need to
-- rename the keys back and drop due_days/remark from rows that never had
-- them; NOT attempted here since no verified tenant depends on the old
-- shape (see note above).

UPDATE schedule_rules
SET template = (
  -- Copy over old-named keys under their new names (only if the new name
  -- isn't already present, so this is idempotent against a partially
  -- migrated row or a re-run).
  (template - 'assignee_id' - 'team_id' - 'due_after_days')
  || CASE
       WHEN template ? 'assignee_id' AND NOT template ? 'assignedTo'
       THEN jsonb_build_object('assignedTo', template->'assignee_id')
       ELSE '{}'::jsonb
     END
  || CASE
       WHEN template ? 'team_id' AND NOT template ? 'teamId'
       THEN jsonb_build_object('teamId', template->'team_id')
       ELSE '{}'::jsonb
     END
  || CASE
       WHEN template ? 'due_after_days' AND NOT template ? 'due_days'
       THEN jsonb_build_object(
              'due_days',
              LEAST((template->>'due_after_days')::numeric, 3650)
            )
       ELSE '{}'::jsonb
     END
  -- remark has no old equivalent to backfill from -- default to an empty
  -- placeholder so TemplateSchema's now-mandatory min(1) still requires an
  -- admin to fill in a real value on the row's next edit, rather than the
  -- rule silently never firing again.
  || CASE
       WHEN NOT template ? 'remark'
       THEN jsonb_build_object('remark', '(no remark set -- please edit this schedule rule)')
       ELSE '{}'::jsonb
     END
)
WHERE template ? 'assignee_id'
   OR template ? 'team_id'
   OR template ? 'due_after_days'
   OR NOT template ? 'remark';
