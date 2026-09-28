-- Take the ticket form payload off the reporting surface.
--
-- ADR-001 grants analytics_user entity_instances "All columns **except
-- `fields`**", because the form payload may hold raw PII. Migration 0113 line
-- 55 granted the table wholesale, which restored `fields` and swept in every
-- column added since — including `search_vector`, which is derived from the
-- same payload and exposes its contents as lexemes.
--
-- Safe to run now because 0121 added `reporting_title` and
-- `reporting_department`, trigger-maintained mirrors of the only two keys any
-- dataset ever read from the payload. The five virtual datasets were repointed
-- onto them in docker/superset/bootstrap.py and proved to return identical
-- results — same row counts, empty symmetric difference in both directions,
-- under the staff scope and again under the own-rows scope. Nothing reads
-- `fields` any more.
--
-- Also withheld, deliberately:
--
--   search_vector   built from the payload; granting it re-exposes the content
--                   `fields` was withheld for, one lexeme at a time
--   origin_*        provenance columns added after ADR-001's table was written.
--                   No dataset reads them, and nobody ever decided they should
--                   be visible — they arrived through the blanket grant. Same
--                   ruling as their counterparts on workflow_events in 0118.
--
-- What this does NOT change: no policy, no role attribute, no view. RLS and the
-- restrictive own-rows policy are untouched. Grants only.
--
-- Rollback (restores the state this replaces — note it re-opens the payload):
--   GRANT SELECT ON entity_instances TO analytics_user;

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_user') THEN
        RAISE NOTICE 'analytics_user absent — nothing to do';
        RETURN;
    END IF;

    -- 1. Drop the table-level grant: the defect itself, and the thing that
    --    makes every future column readable by default.
    EXECUTE 'REVOKE SELECT ON entity_instances FROM analytics_user';

    -- 2. Withdraw the payload and its derivatives explicitly, in case an
    --    earlier hand-run left a column grant behind. Provisioning has to
    --    correct prior state, not merely create correct state.
    EXECUTE 'REVOKE SELECT (fields, search_vector, origin_mechanism, '
            'origin_oidc_client_id, origin_performer_user_id) '
            'ON entity_instances FROM analytics_user';

    -- 3. Re-assert the allowlist: what ADR-001 intended, plus the two
    --    projections 0121 added. Every column here is read by a dataset, a
    --    calculated column, or the RLS join.
    EXECUTE 'GRANT SELECT (id, entity_type_id, tenant_id, workflow_id, '
            'current_state, created_by, assigned_to, created_at, updated_at, '
            'deleted_at, due_date, reporting_title, reporting_department) '
            'ON entity_instances TO analytics_user';
END
$$;

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
-- Expect the thirteen allowlisted columns; fields, search_vector and the three
-- origin_* columns must be absent.
--
--   SELECT column_name FROM information_schema.column_privileges
--    WHERE grantee='analytics_user' AND table_name='entity_instances'
--    ORDER BY column_name;
--
-- Expect zero rows: no table-level grant survives.
--
--   SELECT 1 FROM information_schema.table_privileges
--    WHERE grantee='analytics_user' AND table_name='entity_instances';
--
-- Expect "permission denied for table entity_instances":
--
--   SET ROLE analytics_user;
--   SET app.tenant_id = '<a real tenant>';
--   SELECT fields FROM entity_instances LIMIT 1;
