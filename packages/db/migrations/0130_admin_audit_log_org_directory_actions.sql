-- analytics: excluded (no new table — CHECK constraint update only)
--
-- Audit the admin-triggered org-directory sync's failure path (PR722 review
-- finding: a failed admin-triggered write needs a durable audit record, not
-- just a logger.error line). packages/audit's AuditAction gains the same
-- value in this commit (0077 rule: type and constraint change together).
--
-- Rollback (fails if org_directory.sync_failed rows exist — delete or keep
-- them first):
--   ALTER TABLE admin_audit_log DROP CONSTRAINT audit_log_action_check;
--   ALTER TABLE admin_audit_log ADD CONSTRAINT audit_log_action_check CHECK (
--     action = ANY (ARRAY[
--     'created', 'updated', 'deleted', 'transitioned', 'restored', 'purge.completed',
--     'purge.failed', 'tag.resolved_existing_access', 'tag.auto_granted',
--     'tag.access_request_created', 'tag.fallback', 'tag.resolution_failed',
--     'tag.misuse_rate_capped', 'attachment.quarantined', 'attachment.scan_failed',
--     'transition.executed', 'transition.access_denied', 'comment.created',
--     'comment.access_denied', 'child.created', 'child.access_denied',
--     'attachment.referenced', 'attachment.reference_denied', 'ticket.viewed',
--     'ticket.view_denied', 'ticket.listed', 'workflow.listed',
--     'workflow_fields.listed', 'attachment.downloaded', 'attachment.download_denied',
--     'oncall.auto_assigned', 'oncall.no_schedule', 'oncall.skipped_explicit_assignee',
--     'label.assigned', 'label.removed', 'notification.dispatched',
--     'notification.channel_failed', 'schedule.ticket_created',
--     'schedule.execution_failed', 'schedule.execution_skipped', 'schedule.rule_paused',
--     'schedule.rule_resumed', 'schedule.rule_archived', 'reporting.query_executed',
--     'reporting.exported', 'reporting.guest_token_issued',
--     'reporting.guest_token_denied', 'export.requested', 'export.completed',
--     'export.failed'
--     ]));

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
        'ticket.view_denied', 'ticket.listed', 'workflow.listed',
        'workflow_fields.listed', 'attachment.downloaded', 'attachment.download_denied',
        'oncall.auto_assigned', 'oncall.no_schedule', 'oncall.skipped_explicit_assignee',
        'label.assigned', 'label.removed', 'notification.dispatched',
        'notification.channel_failed', 'schedule.ticket_created',
        'schedule.execution_failed', 'schedule.execution_skipped',
        'schedule.rule_paused', 'schedule.rule_resumed', 'schedule.rule_archived',
        'reporting.query_executed', 'reporting.exported', 'reporting.guest_token_issued',
        'reporting.guest_token_denied', 'export.requested', 'export.completed',
        'export.failed', 'sync_failed'
    ])
);
