-- analytics: excluded (no new table — CHECK constraint update only)
--
-- docs/specs/oncall-routing.md T36 -- adds the 2 label.* action strings
-- used by label assignment/removal (R1c): label.assigned, label.removed.
-- Extended in the same commit as @platform/audit's AuditAction TS union
-- and outcome.ts/request-kind.ts's exhaustiveness maps, per the Phase C
-- B1 incident's self-imposed rule (see migration 0089's comment).
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
--       'oncall.auto_assigned', 'oncall.no_schedule', 'oncall.skipped_explicit_assignee'
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
    'label.assigned', 'label.removed'
  ));
