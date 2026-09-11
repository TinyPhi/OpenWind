-- analytics: excluded (no new table — CHECK constraint update only)
--
-- docs/specs/oncall-routing.md T22 -- adds the 2 notification.* action
-- strings used by dispatch_severity_notification (Phase 3): notification.
-- dispatched (per-dispatch summary) and notification.channel_failed
-- (per-channel failure, reason codes: delivery_failed |
-- provider_not_configured -- see R18b).
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
--       'label.assigned', 'label.removed'
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
    'notification.dispatched', 'notification.channel_failed'
  ));
