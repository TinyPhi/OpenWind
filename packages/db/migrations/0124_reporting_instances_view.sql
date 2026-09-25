-- Give the embedded dashboards a table they are allowed to read wholesale.
--
-- What broke. Migration 0122 replaced the reporting role's table-level grant on
-- entity_instances with a column allowlist, which is what keeps the ticket form
-- payload out of reach. Correct, and it broke 23 of 35 charts on the embedded
-- path — measured, not estimated.
--
-- The cause is a shape, not a column. Superset does not apply a guest token's
-- row filter by appending a WHERE clause to a virtual dataset. It rewrites the
-- base table reference into a filtered subquery:
--
--     FROM (SELECT * FROM entity_instances WHERE (assigned_to = '…' OR …)) AS ei
--
-- `SELECT *` requires table-level SELECT. Column-level grants do not satisfy it,
-- however many columns are granted, and every column that query actually goes on
-- to use was granted. So the database refused a query that asked for nothing it
-- was not entitled to.
--
-- Why it was missed: every check written for 0122 spelled its columns out, so
-- every check passed. The failing statement was only reproduced by replaying it
-- verbatim from the Superset log.
--
-- The fix. A view holding exactly the columns reporting may see. `SELECT *` on
-- it is then harmless — there is no payload column in it to expand to — and the
-- table keeps its column allowlist untouched.
--
-- security_invoker is ON, and that is load-bearing for the same reason it is on
-- migration 0112's view: with it off, the view runs as its owner, who owns the
-- base tables and holds BYPASSRLS, and tenant isolation disappears silently.
-- With it on, row-level security is evaluated as the caller, so the tenant and
-- own-rows policies apply exactly as they do on the table.
--
-- Under invoker semantics the caller needs its own SELECT on the base columns
-- this view reads. It has precisely those, from 0122 and 0123 — which is also
-- why this view works where `workflow_events_masked` could not: that one needed
-- a column the caller was forbidden, this one needs only columns it holds.
--
-- Verified before writing, in a transaction that was rolled back:
--   SELECT * through the view              306 rows
--   Superset's rewrite shape               136 rows
--   cross-tenant probe                     0 rows
--   unstamped connection                   0 rows
--   direct read of entity_instances.fields still refused
--
-- Rollback:
--   DROP VIEW IF EXISTS reporting_instances;
--   -- and repoint the datasets in docker/superset/bootstrap.py back to
--   -- entity_instances, which reinstates the breakage this migration fixes.

BEGIN;

CREATE OR REPLACE VIEW reporting_instances
WITH (security_invoker = true) AS
SELECT
    id,
    entity_type_id,
    tenant_id,
    workflow_id,
    current_state,
    created_by,
    assigned_to,
    created_at,
    updated_at,
    deleted_at,
    due_date,
    -- The projections from 0121 and 0123. The payload they mirror is not here
    -- and must never be added: a column added to this view is readable by every
    -- reporting query the moment it appears, because the whole point of the view
    -- is that callers may select all of it.
    reporting_title,
    reporting_department,
    reporting_priority
FROM entity_instances;

COMMENT ON VIEW reporting_instances IS
    'The reporting-visible projection of entity_instances. Exists so Superset''s '
    'row-filter rewrite (SELECT * FROM <table> WHERE …) has something it may '
    'read in full, while the form payload stays ungranted on the base table. '
    'security_invoker must stay ON — see migration 0112 and '
    'docs/specs/reporting-metadata-masking-repair.md.';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_user') THEN
        EXECUTE 'GRANT SELECT ON reporting_instances TO analytics_user';
    END IF;
END
$$;

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
-- Expect security_invoker=true. If this is ever off, tenant isolation is gone
-- and the only symptom is more rows than there should be.
--
--   SELECT relname, reloptions FROM pg_class WHERE relname = 'reporting_instances';
--
-- Expect rows for the tenant, and 0 for a tenant that owns none:
--
--   SET ROLE analytics_user;
--   SET app.tenant_id = '<a real tenant>';
--   SELECT count(*) FROM (SELECT * FROM reporting_instances) x;
--
-- Expect still refused — the payload is not reachable through the view:
--
--   SELECT fields FROM entity_instances LIMIT 1;
