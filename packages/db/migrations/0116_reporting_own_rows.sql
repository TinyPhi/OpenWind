-- Make "my work only" a database rule, not a dashboard rule.
--
-- The embedded dashboards narrow a non-staff viewer to their own tickets by
-- attaching a second clause to the guest token:
--
--     tenant_id = X AND (assigned_to = me OR created_by = me)
--
-- That clause lives in the token, so it only constrains queries Superset
-- generates from a chart. Stage 2 hands the same person SQL Lab, where they
-- write the query — and the database has never known about the second half.
-- Row-level security here scopes by tenant and nothing else, so without this a
-- customer with a login could read every ticket in their organisation: other
-- people's tickets, comments and assignees. Cross-tenant isolation would hold;
-- the within-tenant boundary the customer dashboard exists to keep would not.
--
-- This moves that boundary into the database, which is the only place it
-- survives a query the user wrote themselves (spec R2: "a user sees only their
-- own tenant's rows, whatever query they write").
--
-- RESTRICTIVE, so it ANDs with the existing tenant policy rather than offering
-- an alternative way in — a permissive policy would *widen* access, which is
-- the opposite of the intent.
--
-- Scoped to analytics_user alone. The application's own role is untouched: the
-- API has its own authorization and must still read tickets on behalf of whoever
-- is entitled to them.
--
-- Defaults to tenant-wide when the scope setting is absent. That is what keeps
-- the embedded path working unchanged: those connections set no scope, so the
-- policy evaluates true and only the tenant clause applies. Staff sessions do
-- the same deliberately.
--
-- A policy naming a role cannot be created before the role exists, and the role
-- comes from docker/postgres/init, not a migration — so this is guarded, same
-- convention as 0009.
--
-- Rollback:
--   DROP POLICY IF EXISTS reporting_own_rows ON entity_instances;
--   DROP POLICY IF EXISTS reporting_own_rows ON workflow_events;

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_user') THEN
    RETURN;
  END IF;

  -- Tickets. `assigned_to` and `created_by` hold the caller's subject id, the
  -- same values the embedded per-user filter compares against.
  EXECUTE 'DROP POLICY IF EXISTS reporting_own_rows ON entity_instances';
  EXECUTE $q$
    CREATE POLICY reporting_own_rows ON entity_instances
        AS RESTRICTIVE
        FOR SELECT
        TO analytics_user
        USING (
            COALESCE(current_setting('app.reporting_scope', true), 'tenant') <> 'own'
            OR assigned_to = current_setting('app.reporting_user_id', true)
            OR created_by  = current_setting('app.reporting_user_id', true)
        )
  $q$;

  -- Events: transitions and comments. Restricted by the ticket they belong to
  -- rather than by actor — a person may read the history of a ticket that is
  -- theirs even where someone else made the move, and must not read the history
  -- of one that is not.
  --
  -- The EXISTS re-enters entity_instances, which is itself filtered by the
  -- policy above, so the two cannot disagree about which tickets are visible.
  EXECUTE 'DROP POLICY IF EXISTS reporting_own_rows ON workflow_events';
  EXECUTE $q$
    CREATE POLICY reporting_own_rows ON workflow_events
        AS RESTRICTIVE
        FOR SELECT
        TO analytics_user
        USING (
            COALESCE(current_setting('app.reporting_scope', true), 'tenant') <> 'own'
            OR EXISTS (
                SELECT 1 FROM entity_instances ei
                WHERE ei.id = workflow_events.instance_id
                  AND (
                      ei.assigned_to = current_setting('app.reporting_user_id', true)
                      OR ei.created_by = current_setting('app.reporting_user_id', true)
                  )
            )
        )
  $q$;
END
$$;

COMMIT;
