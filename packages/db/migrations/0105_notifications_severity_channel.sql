-- analytics: excluded (extends an existing excluded table)
-- down: NOTE — if any 'ticket.severity_notification' rows exist (written by
-- dispatch_severity_notification), either DELETE/re-type them first or this
-- restored CHECK constraint will reject them and the ALTER will fail:
--   DELETE FROM notifications WHERE type = 'ticket.severity_notification';
--   ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
--   ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
--     'entity.assigned', 'comment.mentioned', 'comment.mention_access_granted',
--     'comment.replied', 'access.granted', 'access.revoked', 'workflow.sla_breached',
--     'system.error', 'automation.notify', 'ticket.alert', 'access.updated',
--     'workflow.transitioned', 'entity.updated', 'entity.due_date_approaching',
--     'access_request.created', 'access_request.updated', 'entity.unassigned',
--     'oncall.backup_tagged'
--   ));
--   ALTER TABLE notifications DROP CONSTRAINT notifications_channel_check;
--   ALTER TABLE notifications DROP COLUMN channel;

-- docs/specs/oncall-routing.md T27-T31 (dispatch_severity_notification) --
-- one notifications row per (channel, recipient) pair rather than one row
-- covering all channels, so R18's "per-channel dispatch failures are
-- isolated" has a real, queryable meaning: each channel gets its own row,
-- its own outbound-handoff enqueue attempt, and its own success/failure
-- outcome, instead of being folded into a single opaque delivery. `channel`
-- is nullable (not required) so every existing notification type -- which
-- has no per-channel concept -- is unaffected.
ALTER TABLE notifications ADD COLUMN channel text;

ALTER TABLE notifications ADD CONSTRAINT notifications_channel_check
  CHECK (channel IS NULL OR channel IN ('email', 'sms', 'whatsapp', 'call'));

ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'entity.assigned',
  'comment.mentioned',
  'comment.mention_access_granted',
  'comment.replied',
  'access.granted',
  'access.revoked',
  'workflow.sla_breached',
  'system.error',
  'automation.notify',
  'ticket.alert',
  'access.updated',
  'workflow.transitioned',
  'entity.updated',
  'entity.due_date_approaching',
  'access_request.created',
  'access_request.updated',
  'entity.unassigned',
  'oncall.backup_tagged',
  'ticket.severity_notification'
));
