-- analytics: excluded (extends an existing excluded table's check constraint)
-- down:
--   ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
--   ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
--     'entity.assigned', 'comment.mentioned', 'access.granted', 'access.revoked',
--     'workflow.sla_breached', 'system.error', 'automation.notify'
--   ));

-- Adds 'comment.replied' — replying to someone's comment notifies that
-- comment's original author, distinct from an explicit @mention.
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'entity.assigned',
  'comment.mentioned',
  'comment.replied',
  'access.granted',
  'access.revoked',
  'workflow.sla_breached',
  'system.error',
  'automation.notify'
));
