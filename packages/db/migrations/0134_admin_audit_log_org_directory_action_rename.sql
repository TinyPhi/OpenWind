-- analytics: excluded (no new table — CHECK constraint update only)
--
-- Rename the org-directory sync audit actions to the resource.verb taxonomy
-- (#745, #754): 0130's bare 'sync_failed' becomes 'org_directory.sync_failed',
-- and the success path (previously the generic 'updated') gets its own
-- 'org_directory.sync_completed'. packages/audit's AuditAction changes in the
-- same commit (0077 rule: type and constraint change together). 0130/0131 are
-- already applied, so the swap lands here rather than by editing them.
--
-- admin_audit_log is append-only for app_user (0061). The UPDATE below runs as
-- the migration owner and is a one-time rename of rows written before
-- org-directory's first deploy (dev/staging stacks that already ran 0130), so
-- the new constraint can validate. It changes only the action label, never the
-- actor, resource, metadata or timestamp, and is a no-op on a fresh database.
-- Historical success rows written as 'updated' are left as-is: they can't be
-- told apart from other 'updated' rows on resource_type alone without
-- guessing, and the old value stays valid.
--
-- Must apply after 0133: the migrator skips a migration whose journal
-- timestamp is older than the newest one already applied.
--
-- Rollback (as the migration owner; maps rows back rather than deleting
-- audit history):
--   UPDATE admin_audit_log SET action = 'sync_failed'
--     WHERE action = 'org_directory.sync_failed';
--   UPDATE admin_audit_log SET action = 'updated'
--     WHERE action = 'org_directory.sync_completed';
--   ALTER TABLE admin_audit_log DROP CONSTRAINT audit_log_action_check;
--   then re-add 0131's audit_log_action_check verbatim.

UPDATE admin_audit_log
SET action = 'org_directory.sync_failed'
WHERE action = 'sync_failed';

ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;

ALTER TABLE admin_audit_log ADD CONSTRAINT audit_log_action_check CHECK (
    action = ANY (ARRAY[
        'created', 'updated', 'deleted', 'transitioned', 'restored', 'purge.completed',
        'purge.failed', 'tag.resolved_existing_access', 'tag.auto_granted',
        'tag.access_request_created', 'tag.fallback', 'tag.resolution_failed',
        'tag.misuse_rate_capped', 'attachment.quarantined', 'attachment.scan_failed',
        'transition.executed', 'transition.access_denied', 'comment.created',
        'comment.access_denied', 'child.created', 'child.access_denied',
        'attachment.referenced', 'attachment.reference_denied', 'ticket.viewed',
        'ticket.view_denied', 'ticket.listed', 'workflow.listed', 'workflow_fields.listed',
        'attachment.downloaded', 'attachment.download_denied', 'oncall.auto_assigned',
        'oncall.no_schedule', 'oncall.skipped_explicit_assignee', 'label.assigned',
        'label.removed', 'notification.dispatched', 'notification.channel_failed',
        'schedule.ticket_created', 'schedule.execution_failed', 'schedule.execution_skipped',
        'schedule.rule_paused', 'schedule.rule_resumed', 'schedule.rule_archived',
        'reporting.query_executed', 'reporting.exported', 'reporting.guest_token_issued',
        'reporting.guest_token_denied', 'export.requested', 'export.completed',
        'export.failed', 'export.downloaded', 'export.download_denied',
        'org_directory.sync_completed', 'org_directory.sync_failed'
    ])
);
