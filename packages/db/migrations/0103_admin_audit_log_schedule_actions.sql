-- analytics: excluded (no new table — CHECK constraint update only)
--
-- docs/specs/temporal-scheduler.md T3 -- adds the 6 schedule.* action
-- strings (docs/temporal-scheduler-design.md §1.4). schedule.rule_paused
-- covers both a manual admin pause and the auto-pause-on-stale-owner/
-- repeated-failure mechanism (see this project's open-questions.md) --
-- the two are distinguished by a metadata reason field at write time, not
-- by separate action strings.
--
-- Rollback (undoes only what THIS migration added):
--   ALTER TABLE admin_audit_log DROP CONSTRAINT audit_log_action_check;
--   ALTER TABLE admin_audit_log
--     ADD CONSTRAINT audit_log_action_check
--     CHECK (action IN (
--       'created', 'updated', 'deleted', 'transitioned', 'restored',
--       'purge.completed', 'purge.failed',
--       'tag.resolved_existing_access', 'tag.auto_granted',
--       'tag.access_request_created', 'tag.fallback',
--       'tag.resolution_failed', 'tag.misuse_rate_capped',
--       'attachment.quarantined', 'attachment.scan_failed',
--       'transition.executed', 'transition.access_denied',
--       'comment.created', 'comment.access_denied',
--       'child.created', 'child.access_denied',
--       'attachment.referenced', 'attachment.reference_denied',
--       'ticket.viewed', 'ticket.view_denied',
--       'ticket.listed',
--       'workflow.listed',
--       'workflow_fields.listed',
--       'attachment.downloaded', 'attachment.download_denied',
--       'oncall.auto_assigned', 'oncall.no_schedule', 'oncall.skipped_explicit_assignee',
--       'label.assigned', 'label.removed',
--       'notification.dispatched', 'notification.channel_failed'
--     ));

ALTER TABLE admin_audit_log DROP CONSTRAINT audit_log_action_check;

ALTER TABLE admin_audit_log
  ADD CONSTRAINT audit_log_action_check
  CHECK (action IN (
    'created', 'updated', 'deleted', 'transitioned', 'restored',
    'purge.completed', 'purge.failed',
    'tag.resolved_existing_access', 'tag.auto_granted',
    'tag.access_request_created', 'tag.fallback',
    'tag.resolution_failed', 'tag.misuse_rate_capped',
    'attachment.quarantined', 'attachment.scan_failed',
    'transition.executed', 'transition.access_denied',
    'comment.created', 'comment.access_denied',
    'child.created', 'child.access_denied',
    'attachment.referenced', 'attachment.reference_denied',
    'ticket.viewed', 'ticket.view_denied',
    'ticket.listed',
    'workflow.listed',
    'workflow_fields.listed',
    'attachment.downloaded', 'attachment.download_denied',
    'oncall.auto_assigned', 'oncall.no_schedule', 'oncall.skipped_explicit_assignee',
    'label.assigned', 'label.removed',
    'notification.dispatched', 'notification.channel_failed',
    'schedule.ticket_created', 'schedule.execution_failed', 'schedule.execution_skipped',
    'schedule.rule_paused', 'schedule.rule_resumed', 'schedule.rule_archived'
  ));
