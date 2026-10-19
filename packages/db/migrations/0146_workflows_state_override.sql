-- analytics: excluded (no new table — a column and a CHECK constraint update only)
--
-- Hardening (guarded state override): the per-workflow switch that allows a recorded, reasoned
-- override of a record's state, plus the two audit actions that record its use and any change to
-- the switch. packages/audit's AuditAction gains the same values in this commit (0136 rule: type and
-- constraint change together).
--
-- The switch defaults to false: a workflow only allows overrides when an admin turns it on.
-- Mirrors 0074 (allow_auto_grant_on_mention).
--
-- Re-lists every value from 0145_admin_audit_log_transition_conditions_action.sql, the constraint
-- this builds on: a DROP + ADD of this constraint silently removes any value it does not re-list, so
-- a later migration that widens it again must carry this one's forward.
--
-- Rollback (the constraint step fails if rows using the values added here exist — delete or keep
-- them first):
--   ALTER TABLE workflows DROP COLUMN allow_state_override;
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
--   'workflow.transition_conditions_updated'
--   ])
--   );

ALTER TABLE workflows
  ADD COLUMN IF NOT EXISTS allow_state_override boolean NOT NULL DEFAULT false;

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
        'workflow.state_overridden', 'workflow.override_policy_updated'
    ])
);
