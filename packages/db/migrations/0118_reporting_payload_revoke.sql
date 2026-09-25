-- Take the raw event payload off the reporting surface, and restore the column
-- allowlist that migration 0112 intended.
--
-- What went wrong. 0112 granted eleven named columns on workflow_events and
-- deliberately omitted `metadata`, saying so in its own comment:
--
--     "that redaction is only worth anything while the raw column stays
--      ungranted — otherwise the view is a formality the caller can step around
--      by selecting the base table directly."
--
-- 0113 line 56 then issued a blanket `GRANT SELECT ON workflow_events TO
-- analytics_user`. A table-level grant covers every column, present and future,
-- so it silently undid 0112's allowlist: `metadata` came back, and the three
-- origin_* columns added later were swept in without anyone deciding.
--
-- Measured on this database before writing: a non-staff analyst reading
-- workflow_events got back actor names and attached filenames, e.g.
-- {"type":"file_attached","originalName":"...pdf"} — the PII/financial values
-- ADR-001 excludes from reporting.
--
-- Why this is safe to run now. Migration 0117 added `event_type`, a derived
-- mirror of metadata->>'type', and that single key was the only thing reporting
-- ever read from the payload. The five virtual datasets were repointed onto it
-- in docker/superset/bootstrap.py and proved to return identical results — same
-- row counts and an empty symmetric difference in both directions, under the
-- staff scope and again under the own-rows scope. Nothing reads `metadata` any
-- more, so withdrawing it changes no chart.
--
-- What this does NOT change. No policy, no role attribute, no view semantics.
-- security_invoker stays as 0112 set it, analytics_user stays NOBYPASSRLS, and
-- the restrictive reporting_own_rows policy is untouched. Grants only.
--
-- Rollback (restores the state this migration replaces — note that doing so
-- re-opens the PII exposure above):
--   GRANT SELECT ON workflow_events TO analytics_user;

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_user') THEN
        RAISE NOTICE 'analytics_user absent — nothing to do';
        RETURN;
    END IF;

    -- 1. Drop the table-level grant. This is the defect: it is what makes every
    --    column readable, including any column added to this table in future.
    EXECUTE 'REVOKE SELECT ON workflow_events FROM analytics_user';

    -- 2. Withdraw the payload and the three provenance columns explicitly.
    --    Belt and braces: step 1 should be sufficient, but an explicit column
    --    revoke also clears a column-level grant if some earlier hand-run left
    --    one behind. Provisioning that only creates correct state is not enough
    --    — it has to correct state left behind by earlier revisions of itself.
    EXECUTE 'REVOKE SELECT (metadata, origin_mechanism, origin_oidc_client_id, '
            'origin_performer_user_id) ON workflow_events FROM analytics_user';

    -- 3. Re-assert the allowlist: 0112's eleven columns, plus the derived
    --    classification 0117 added. `comment` stays, as it did in 0112 — the
    --    five datasets all read it, and ADR-001's scope is field values marked
    --    pii or financial rather than free text in general. That is a recorded
    --    decision, not an oversight; see the spec's OQ-1.
    EXECUTE 'GRANT SELECT (id, tenant_id, workflow_id, instance_id, from_state, '
            'to_state, triggered_by, actor_id, comment, idempotency_key, '
            'created_at, event_type) ON workflow_events TO analytics_user';
END
$$;

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
-- Expect the twelve allowlisted columns and nothing else. metadata and the
-- three origin_* columns must be absent.
--
--   SELECT column_name FROM information_schema.column_privileges
--    WHERE grantee='analytics_user' AND table_name='workflow_events'
--    ORDER BY column_name;
--
-- Expect zero rows: no table-level grant survives.
--
--   SELECT 1 FROM information_schema.table_privileges
--    WHERE grantee='analytics_user' AND table_name='workflow_events';
--
-- Expect "permission denied for column metadata", not a result set:
--
--   SET ROLE analytics_user;
--   SET app.tenant_id = '<a real tenant>';
--   SELECT metadata FROM workflow_events LIMIT 1;
