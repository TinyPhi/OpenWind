-- analytics: excluded (data fix on existing automation_rules rows only -- no new table)
--
-- docs/specs/mandatory-ticket-fields.md (owner decision 2026-10-19). Assigning a ticket to a
-- team resolves it to the team's on-call person through two helpdesk-seeded automation rules
-- (resolve_oncall on entity.created / entity.updated). They were scoped to the entity type
-- named 'ticket', so a team-assigned record on any other workflow never got a person. The
-- seed now creates them unscoped; this widens existing tenants' rows. The action returns
-- early for a record with no team, so nothing else changes.
--
-- DOWN MIGRATION:
--   UPDATE automation_rules SET trigger_config = trigger_config || '{"entityType": "ticket"}'::jsonb
--   WHERE tenant_id IS NOT NULL AND name IN (
--     'Auto-assign on-call user when team is set on ticket creation',
--     'Auto-assign on-call user when ticket team changes');

UPDATE automation_rules
SET trigger_config = trigger_config - 'entityType'
WHERE tenant_id IS NOT NULL
  AND name IN (
    'Auto-assign on-call user when team is set on ticket creation',
    'Auto-assign on-call user when ticket team changes'
  )
  AND actions @> '[{"type": "resolve_oncall"}]'::jsonb
  AND trigger_config ->> 'entityType' = 'ticket';
