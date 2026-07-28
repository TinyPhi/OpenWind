-- analytics: excluded (extends an existing excluded table's check constraint)
-- down:
--   ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
--   ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
--     'entity.assigned', 'comment.mentioned', 'comment.replied', 'access.granted',
--     'access.revoked', 'workflow.sla_breached', 'system.error', 'automation.notify'
--   ));

-- Adds 'comment.mention_access_granted' — distinct from a plain 'comment.mentioned':
-- fires when a mention also grants brand-new access (the mentioned user had none
-- before), so the recipient is told about the access change, not just the mention.
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
  'automation.notify'
));
