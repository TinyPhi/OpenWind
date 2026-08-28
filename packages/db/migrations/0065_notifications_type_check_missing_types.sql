-- analytics: excluded (extends an existing excluded table's check constraint)
-- down:
--   ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
--   ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
--     'entity.assigned', 'comment.mentioned', 'comment.mention_access_granted',
--     'comment.replied', 'access.granted', 'access.revoked', 'workflow.sla_breached',
--     'system.error', 'automation.notify', 'ticket.alert'
--   ));

-- The notification-hub gap-closure work (commit a9618e7) wired 6 new event
-- types all the way through NOTIFICATION_EVENT_TYPES / resolveRecipients /
-- buildNotificationContent, but never extended this CHECK constraint —
-- every INSERT for these types passed recipient resolution and template
-- build, then failed silently at the DB layer and landed in
-- dead_letter_events. A CHECK constraint enum is a silent failure mode a
-- mocked-DB unit test can't catch; this is the required companion fix.
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
  'access_request.updated'
));
