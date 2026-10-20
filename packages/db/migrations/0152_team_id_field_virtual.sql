-- analytics: excluded (data fix on existing entity_fields rows only -- no new table)
--
-- docs/specs/mandatory-ticket-fields.md, PR #975 review (ADR-004 config-first). Every
-- per-tenant entity type gets a `team_id` field at creation (entity-types.ts); its value is
-- set through the User/Team assign control, never as a generic input. The admin UI used to
-- hide it by checking the name `team_id`; it now skips `config.virtual` fields, the same flag
-- helpdesk's severity field carries (0150). New entity types get the flag at creation; this
-- brings existing tenants' team_id fields in line.
--
-- DOWN MIGRATION:
--   UPDATE entity_fields SET config = config - 'virtual'
--   WHERE name = 'team_id' AND tenant_id IS NOT NULL;

UPDATE entity_fields
SET config = config || '{"virtual": true}'::jsonb
WHERE name = 'team_id'
  AND tenant_id IS NOT NULL
  AND NOT coalesce((config ->> 'virtual')::boolean, false);
