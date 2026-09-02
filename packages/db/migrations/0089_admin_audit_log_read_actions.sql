-- analytics: excluded (no new table — CHECK constraint update only)
--
-- ADR-012 Phase F follow-up: the third-party access-logs screen only ever
-- had write actions to show (comments/children/attachments/transitions/
-- ticket-create) — every READ endpoint (GET ticket detail, GET ticket list,
-- GET workflows, GET workflow fields, GET attachment download) wrote no
-- admin_audit_log row at all, allowed or denied. A caller who only ever
-- reads ticket data leaves zero trail. Adds 6 new actions, mirroring the
-- existing allowed/denied-pair convention (see 0081's comment.created/
-- comment.access_denied) — extended in the same commit as @platform/audit's
-- AuditAction TS union and outcome.ts's exhaustiveness map, per the Phase C
-- B1 incident's self-imposed rule.
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
--       'attachment.referenced', 'attachment.reference_denied'
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
    'attachment.downloaded', 'attachment.download_denied'
  ));
