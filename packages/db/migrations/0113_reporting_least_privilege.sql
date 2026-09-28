-- Narrow the reporting role to the tables reporting actually reads.
--
-- Stage 1 (embedded dashboards) could tolerate a wide grant: users cannot write
-- queries, and the only things they can reach are six provisioned datasets.
-- Stage 2 removes that cover — an analyst writes their own SQL, so every table
-- the role can read becomes reachable. The spec makes the repair a gate on
-- opening that stage, not a follow-up
-- (docs/specs/superset-standalone-with-zitadel.md §P2, §C "data surface").
--
-- Measured before writing this, on the live database: analytics_user could read
-- 34 tables, 7 of them with row-level security switched off. Three of those
-- matter:
--
--   tenants              RLS off, so `SELECT * FROM tenants` returns every
--                        tenant — the exact case R2 says must return zero rows
--                        rather than all rows.
--   pg_stat_statements   992 rows of query text drawn from every tenant's
--                        activity. Literals are parameterised, but table names,
--                        query shapes and volumes are not.
--   platform_settings    instance-wide configuration, no tenant column.
--
-- The remaining wide grants (modules, plugin_definitions, connector_definitions)
-- are global reference data with no tenant scoping, and nothing in reporting
-- reads them.
--
-- Tables that keep the grant are exactly those the provisioned datasets query.
-- Adding a dataset that needs another table means adding it here, deliberately,
-- which is the point: the spec asks for column-level review as part of adding a
-- dataset, and a role that can already read everything makes that review moot.
--
-- Revoking rather than relying on RLS is the belt to RLS's braces. RLS answers
-- "which rows", this answers "which tables at all" — and the tables removed here
-- are precisely the ones where RLS has no answer because they carry no tenant.
--
-- The role is created by docker/postgres/init, not by a migration, so every
-- statement naming it is guarded — same convention as 0009.
--
-- Rollback (restores the wide grant this migration removes, and with it the
-- cross-tenant reads described above):
--   GRANT SELECT ON ALL TABLES IN SCHEMA public TO analytics_user;
--   GRANT SELECT ON pg_stat_statements, pg_stat_statements_info TO PUBLIC;

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_user') THEN
    RETURN;
  END IF;

  -- Start from nothing. REVOKE is per-object, so this covers tables and views
  -- that exist today; the default privileges below cover ones added later.
  EXECUTE 'REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM analytics_user';

  -- Future tables must not be granted by accident. Without this, a later
  -- migration that grants the role broadly, or a default privilege set
  -- elsewhere, silently reopens the surface this migration closed.
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM analytics_user';

  -- The reporting surface, one table per reason:
  --   entity_instances        tickets — every count, state and workload tile
  --   workflow_events         transitions — dwell time and first-response datasets
  --   workflow_events_masked  the PII-masked view of the same (ADR-001)
  --   workflows               workflow names, so a tile can say "Helpdesk"
  --   workflow_states         is_terminal, so open/closed is derived from the
  --                           workflow's own definition instead of a hardcoded
  --                           list of state names
  --   tenant_users            display names, so a chart shows a person not an id
  --   entity_types            record_type_slug, the URL segment used to link a
  --                           table row back to its real ticket in OpenWind.
  --                           RLS is on, so this does not reopen the tenant leak
  --                           the rest of this migration closes.
  EXECUTE 'GRANT SELECT ON entity_instances       TO analytics_user';
  EXECUTE 'GRANT SELECT ON workflow_events        TO analytics_user';
  EXECUTE 'GRANT SELECT ON workflow_events_masked TO analytics_user';
  EXECUTE 'GRANT SELECT ON workflows              TO analytics_user';
  EXECUTE 'GRANT SELECT ON workflow_states        TO analytics_user';
  EXECUTE 'GRANT SELECT ON tenant_users           TO analytics_user';
  EXECUTE 'GRANT SELECT ON entity_types           TO analytics_user';
END
$$;

-- pg_stat_statements is granted to PUBLIC by the extension itself, so revoking
-- from the reporting role alone leaves it readable. It holds 992 rows of query
-- text drawn from every tenant's activity on this instance: literals are
-- parameterised, but table names, query shapes and volumes are not, and none of
-- it is tenant-scoped. An analyst writing their own SQL would otherwise have a
-- cross-tenant activity feed.
--
-- Revoked from PUBLIC rather than from one role, because PUBLIC is where the
-- grant actually lives. The owner (platform) keeps full access, so monitoring
-- that connects as the owner is unaffected.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'pg_stat_statements') THEN
        EXECUTE 'REVOKE SELECT ON pg_stat_statements FROM PUBLIC';
        EXECUTE 'REVOKE SELECT ON pg_stat_statements_info FROM PUBLIC';
    END IF;
END $$;

COMMIT;
