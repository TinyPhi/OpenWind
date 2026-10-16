-- analytics: excluded (role and grants only -- no new table)
--
-- Event-log protection (docs/specs/event-log-protection.md). app_user could UPDATE and DELETE
-- any workflow_events row of its tenant, so a bug or a compromised request path could rewrite
-- a case's history (state, timestamps, who acted). Now:
--   - app_user keeps SELECT and INSERT, plus UPDATE on three columns: metadata (comment
--     attachments, resolved mentions, erasure scrubbing) and actor_id / origin_performer_user_id
--     (per-user erasure redacts them). from_state, to_state, created_at, triggered_by and the
--     other columns are immutable to it. A trigger lets actor_id and origin_performer_user_id
--     change only to the redaction marker, so history can be anonymized but never re-attributed.
--   - DELETE moves to event_log_maintenance_role (NOLOGIN, NOBYPASSRLS, granted to app_user WITH
--     INHERIT FALSE like tenant_purge_role, 0144), entered through
--     withEventLogMaintenanceContext. The retention sweep, tenant purge and sandbox reset use it.
--     The existing tenant RLS policies still confine it to the tenant in app.tenant_id.
--   - The role also reads entity_instances and workflow_states: the retention sweep's evidence
--     guard (never delete history of an open or recently active case) reads them.
--
-- DOWN MIGRATION:
--   REVOKE SELECT ON entity_instances, workflow_states FROM event_log_maintenance_role;
--   REVOKE SELECT, DELETE ON workflow_events FROM event_log_maintenance_role;
--   REVOKE USAGE ON SCHEMA public FROM event_log_maintenance_role;
--   REVOKE event_log_maintenance_role FROM app_user;
--   DROP ROLE IF EXISTS event_log_maintenance_role;
--   DROP TRIGGER IF EXISTS workflow_events_identity_guard ON workflow_events;
--   DROP FUNCTION IF EXISTS workflow_events_identity_guard();
--   REVOKE UPDATE (metadata, actor_id, origin_performer_user_id) ON workflow_events FROM app_user;
--   GRANT UPDATE, DELETE ON workflow_events TO app_user;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'event_log_maintenance_role') THEN
    CREATE ROLE event_log_maintenance_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT event_log_maintenance_role TO app_user WITH INHERIT FALSE;
GRANT USAGE ON SCHEMA public TO event_log_maintenance_role;
GRANT SELECT, DELETE ON workflow_events TO event_log_maintenance_role;
GRANT SELECT ON entity_instances, workflow_states TO event_log_maintenance_role;

REVOKE UPDATE, DELETE ON workflow_events FROM app_user;
GRANT UPDATE (metadata, actor_id, origin_performer_user_id) ON workflow_events TO app_user;

-- Must match REDACTED in apps/api/src/services/user-erasure.ts.
CREATE OR REPLACE FUNCTION workflow_events_identity_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.actor_id IS DISTINCT FROM OLD.actor_id
     AND (NEW.actor_id IS DISTINCT FROM '[REDACTED]' OR OLD.actor_id IS NULL) THEN
    RAISE EXCEPTION 'workflow_events.actor_id may only be redacted' USING ERRCODE = '42501';
  END IF;
  IF NEW.origin_performer_user_id IS DISTINCT FROM OLD.origin_performer_user_id
     AND (NEW.origin_performer_user_id IS DISTINCT FROM '[REDACTED]' OR OLD.origin_performer_user_id IS NULL) THEN
    RAISE EXCEPTION 'workflow_events.origin_performer_user_id may only be redacted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_events_identity_guard ON workflow_events;
CREATE TRIGGER workflow_events_identity_guard
  BEFORE UPDATE OF actor_id, origin_performer_user_id ON workflow_events
  FOR EACH ROW EXECUTE FUNCTION workflow_events_identity_guard();
