-- Migration: 0111_schedule_sweeper_entity_instance_tags_grant
-- analytics: excluded (grant only -- no table, no analytics surface)
--
-- PR #659 review (Vijit), G8: schedule_sweeper (BYPASSRLS role, migration
-- 0107) bypasses RLS but not object-level privileges. The current GDPR
-- purge path doesn't need a direct grant here (CASCADE delete from
-- entity_instances handles entity_instance_tags automatically), but any
-- future explicit SELECT against this table by the sweeper would fail at
-- runtime with permission denied without this grant. Matches the existing
-- pattern (0107's own GRANT SELECT, UPDATE ON schedule_rules).
--
-- DOWN MIGRATION:
-- REVOKE SELECT ON entity_instance_tags FROM schedule_sweeper;

GRANT SELECT ON entity_instance_tags TO schedule_sweeper;
