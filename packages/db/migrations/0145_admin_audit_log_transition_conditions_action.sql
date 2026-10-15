-- analytics: excluded (no new table — CHECK constraint update only)
--
-- Hardening (segregation of duties): an audit action for changes to a workflow transition's
-- `conditions`, which is where the segregation-of-duties rules live. Changing or removing such a
-- rule changes who may approve what, so it is recorded the way transition role changes are.
-- packages/audit's AuditAction gains the same value in this commit (0136 rule: type and
-- constraint change together).
--
-- Re-lists every value from 0140_admin_audit_log_access_actions.sql, the constraint this builds on:
-- a DROP + ADD of this constraint silently removes any value it does not re-list, so a later
-- migration that widens it again must carry this one's forward.
--
-- Must apply after 0140 (and after any later migration that widens audit_log_action_check).
--
-- Rollback (fails if rows using the value added here exist — delete or keep them first):
--   ALTER TABLE admin_audit_log DROP CONSTRAINT audit_log_action_check;
--   ALTER TABLE admin_audit_log ADD CONSTRAINT audit_log_action_check CHECK (
--   action = ANY (ARRAY[
--   'created', 'updated', 'deleted', 'transitioned', 'restored', 'purge.completed',
--   'purge.failed', 'tag.resolved_existing_access', 'tag.auto_granted',
--   'tag.access_request_created', 'tag.fallback', 'tag.resolution_failed',
--   'tag.misuse_rate_capped', 'attachment.quarantined', 'attachment.scan_failed',
--   'transition.executed', 'transition.access_denied', 'comment.created',
--   'comment.access_denied', 'child.created', 'child.access_denied',
--   'attachment.referenced', 'attachment.reference_denied', 'ticket.viewed',
--   'ticket.view_denied', 'ticket.listed', 'workflow.listed', 'workflow_fields.listed',
--   'attachment.downloaded', 'attachment.download_denied', 'oncall.auto_assigned',
--   'oncall.no_schedule', 'oncall.skipped_explicit_assignee', 'label.assigned',
--   'label.removed', 'notification.dispatched', 'notification.channel_failed',
--   'schedule.ticket_created', 'schedule.execution_failed', 'schedule.execution_skipped',
--   'schedule.rule_paused', 'schedule.rule_resumed', 'schedule.rule_archived',
--   'reporting.query_executed', 'reporting.exported', 'reporting.guest_token_issued',
--   'reporting.guest_token_denied', 'export.requested', 'export.completed',
--   'export.failed', 'export.downloaded', 'export.download_denied',
--   'org_directory.sync_completed', 'org_directory.sync_failed',
--   'sandbox.provisioning_completed', 'sandbox.provisioning_failed',
--   'sandbox.reset_completed', 'sandbox.reset_failed', 'sandbox.delete_completed',
--   'sandbox.delete_failed', 'access.granted', 'access.updated', 'access.revoked',
--   'workflow.admins_updated', 'workflow.transition_roles_updated'
--   ])
--   );

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
        'workflow.admins_updated', 'workflow.transition_roles_updated',
        'workflow.transition_conditions_updated'
    ])
);
