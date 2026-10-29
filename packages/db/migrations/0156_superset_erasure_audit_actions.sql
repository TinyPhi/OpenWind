-- analytics: excluded (no new table — CHECK constraint update only)
--
-- #728 (docs/specs/superset-gdpr-erasure.md): two audit actions for the outcome of erasing a user's,
-- or a purged tenant's, data from Superset. superset_erasure.completed is written when the worker's
-- job finishes (with the counts), superset_erasure.failed once, on the last failed attempt. Both are
-- written as the system with the same tenant and resource id as the platform's own "deleted" or
-- "purge.completed" row, so a search by resource shows who asked and when Superset was cleaned.
-- packages/audit's AuditAction gains the same values in this commit (0136 rule: type and
-- constraint change together).
--
-- Re-lists every value from 0146_workflows_state_override.sql, the constraint this builds on: a
-- DROP + ADD of this constraint silently removes any value it does not re-list, so a later
-- migration that widens it again must carry this one's forward.
--
-- Must apply after 0146 (and after any later migration that widens audit_log_action_check).
--
-- Rollback (fails if rows using the values added here exist — delete or keep them first):
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
--   'workflow.admins_updated', 'workflow.transition_roles_updated',
--   'workflow.transition_conditions_updated',
--   'workflow.state_overridden', 'workflow.override_policy_updated'
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
        'workflow.transition_conditions_updated',
        'workflow.state_overridden', 'workflow.override_policy_updated',
        'superset_erasure.completed', 'superset_erasure.failed'
    ])
);
