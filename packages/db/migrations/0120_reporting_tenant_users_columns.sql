-- Stop the reporting role reading user email addresses.
--
-- ADR-001 lists `tenant_users` as **excluded** from analytics_user, reason
-- given as "user_id is PII under GDPR". Migration 0113 line 60 granted it
-- anyway, table-level, for a good reason stated right there in its own comment:
--
--     tenant_users            display names, so a chart shows a person not an id
--
-- The need is real — "Workload by User" reading `386221886528290819` instead of
-- "Bob Tester" is not a report anybody wants. But a whole-table grant took the
-- email column along with the display name, and no dataset has ever asked for
-- email. Measured before writing this: analytics_user could select
-- owAdmin@openwind.local and testUser2@openwind.local straight out of the table.
--
-- Same defect shape as 0113's grant on workflow_events, which 0118 repaired: a
-- table-level grant used where the requirement was three columns. This one is
-- smaller because nothing needs replacing first — the columns reporting wants
-- are already columns, so there is nothing to derive and nothing to repoint.
--
-- What actually gets used, confirmed against every dataset definition and the
-- two calculated columns on entity_instances that resolve names:
--
--     tu.user_id       join key against entity_instances.assigned_to/created_by
--     tu.tenant_id     join key, and what the RLS policy filters on
--     tu.display_name  the reason the grant exists
--
-- `id`, `created_at` and `email` are not read by anything. They are not granted.
--
-- Tenant isolation is unchanged: tenant_users keeps its own RLS, and this only
-- narrows which columns the role may see within the rows it could already read.
--
-- Rollback (restores the state this replaces — note it re-exposes email):
--   GRANT SELECT ON tenant_users TO analytics_user;

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_user') THEN
        RAISE NOTICE 'analytics_user absent — nothing to do';
        RETURN;
    END IF;

    -- Drop the whole-table grant, which is what swept in email and would sweep
    -- in any column added to this table in future.
    EXECUTE 'REVOKE SELECT ON tenant_users FROM analytics_user';

    -- Explicit, in case a hand-run ever left a column grant behind.
    EXECUTE 'REVOKE SELECT (id, created_at, email) ON tenant_users '
            'FROM analytics_user';

    EXECUTE 'GRANT SELECT (user_id, tenant_id, display_name) ON tenant_users '
            'TO analytics_user';
END
$$;

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
-- Expect exactly: display_name, tenant_id, user_id
--
--   SELECT column_name FROM information_schema.column_privileges
--    WHERE grantee='analytics_user' AND table_name='tenant_users'
--    ORDER BY column_name;
--
-- Expect "permission denied for table tenant_users":
--
--   SET ROLE analytics_user;
--   SET app.tenant_id = '<a real tenant>';
--   SELECT email FROM tenant_users LIMIT 1;
--
-- Expect display names to still resolve (this is what the grant is for):
--
--   SELECT display_name FROM tenant_users LIMIT 1;
