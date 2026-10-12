-- analytics: excluded (no new table — CHECK constraint update only)
--
-- #640 — audit actions for changes to who can do what inside OpenWind's own tables
-- (ticket ACL grants, workflow admin lists, transition role gates). packages/audit's
-- AuditAction gains the same five values in this commit (0136 rule: type and constraint
-- change together).
--
-- Re-lists sandbox.delete_completed / sandbox.delete_failed, added by
-- 0139_admin_audit_log_sandbox_delete_actions.sql (#838), which this builds on. A DROP + ADD of
-- this constraint silently removes any value it does not re-list, so every earlier value must be
-- carried forward; a later migration that widens it again must do the same for this one's.
--
-- Must apply after 0139 (admin_audit_log_sandbox_delete_actions), whose CHECK constraint this
-- one is built on top of.
--
-- Rollback (fails if rows using any value added here exist — delete or keep them first):
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
--     'ticket.view_denied', 'ticket.listed', 'workflow.listed', 'workflow_fields.listed',
--     'attachment.downloaded', 'attachment.download_denied', 'oncall.auto_assigned',
--     'oncall.no_schedule', 'oncall.skipped_explicit_assignee', 'label.assigned',
--     'label.removed', 'notification.dispatched', 'notification.channel_failed',
--     'schedule.ticket_created', 'schedule.execution_failed', 'schedule.execution_skipped',
--     'schedule.rule_paused', 'schedule.rule_resumed', 'schedule.rule_archived',
--     'reporting.query_executed', 'reporting.exported', 'reporting.guest_token_issued',
--     'reporting.guest_token_denied', 'export.requested', 'export.completed', 'export.failed',
--     'export.downloaded', 'export.download_denied', 'org_directory.sync_completed',
--     'org_directory.sync_failed', 'sandbox.provisioning_completed',
--     'sandbox.provisioning_failed', 'sandbox.reset_completed', 'sandbox.reset_failed'
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
        'ticket.view_denied', 'ticket.listed', 'workflow.listed', 'workflow_fields.listed',
        'attachment.downloaded', 'attachment.download_denied', 'oncall.auto_assigned',
        'oncall.no_schedule', 'oncall.skipped_explicit_assignee', 'label.assigned',
        'label.removed', 'notification.dispatched', 'notification.channel_failed',
        'schedule.ticket_created', 'schedule.execution_failed', 'schedule.execution_skipped',
        'schedule.rule_paused', 'schedule.rule_resumed', 'schedule.rule_archived',
        'reporting.query_executed', 'reporting.exported', 'reporting.guest_token_issued',
        'reporting.guest_token_denied', 'export.requested', 'export.completed',
        'export.failed', 'export.downloaded', 'export.download_denied',
        'org_directory.sync_completed', 'org_directory.sync_failed',
        'sandbox.provisioning_completed', 'sandbox.provisioning_failed',
        'sandbox.reset_completed', 'sandbox.reset_failed', 'sandbox.delete_completed',
        'sandbox.delete_failed', 'access.granted', 'access.updated', 'access.revoked',
        'workflow.admins_updated', 'workflow.transition_roles_updated'
    ])
);
