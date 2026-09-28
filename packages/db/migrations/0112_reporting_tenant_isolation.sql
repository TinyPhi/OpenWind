-- analytics: excluded (no new table — role attribute and view options only)
--
-- docs/specs/superset-embedded-dashboarding.md §P1 / §P1b, tasks T2, T3b.
--
-- Makes reporting isolation a database guarantee rather than a filter the
-- application remembers to attach. Three changes, and all three are required
-- together — any one alone leaves the boundary broken:
--
--   1. analytics_user stops bypassing RLS
--   2. views it reads evaluate RLS as the caller, not as their owner
--   3. it gets its own SELECT on the base tables those views read
--
-- Why (1). analytics_user was created with BYPASSRLS, so every policy on every
-- table was inert for the reporting connection. Tenant separation rested
-- entirely on a filter attached at pass-mint time — one layer, where
-- .claude/rules/security.md rule 1 requires two, and a bug in that single layer
-- yields another tenant's rows rather than none. Superset now stamps
-- app.tenant_id per connection (DB_CONNECTION_MUTATOR in
-- docker/superset/superset_config.py), so the existing policies can do their
-- job and an unstamped connection sees nothing.
--
-- Why (2). This is the part that is easy to miss and silently fatal. A
-- PostgreSQL view executes with its OWNER's privileges unless
-- security_invoker is set, so RLS on the underlying table is evaluated as the
-- view owner — migration_user, which bypasses RLS. Measured on a live database
-- before writing this: querying workflow_events directly as a non-bypass role,
-- claiming a tenant that owns none of the rows, returned 0 rows; the same
-- query through workflow_events_masked returned all 48. The view was a hole
-- straight through the isolation boundary, and it would have opened the moment
-- change (1) landed and made everything else look correct.
--
-- Why (3). With security_invoker on, the view stops lending its owner's access
-- to the caller, so analytics_user needs its own SELECT on the base tables. The
-- masking the view performs still applies — it is the same view, evaluated as
-- the caller.
--
-- Rollback (undoes only what THIS migration added):
--   ALTER VIEW workflow_events_masked RESET (security_invoker);
--   REVOKE SELECT (id, tenant_id, workflow_id, instance_id, from_state,
--     to_state, triggered_by, actor_id, comment, idempotency_key, created_at,
--     metadata) ON workflow_events FROM analytics_user;
--   ALTER USER analytics_user BYPASSRLS;

-- ── 1. The reporting role stops bypassing row-level security ────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_user') THEN
    EXECUTE 'ALTER USER analytics_user NOBYPASSRLS';
  END IF;
END
$$;

-- ── 2. Views evaluate RLS as the caller, not as their owner ─────────────────
-- Requires PostgreSQL 15+. The platform runs 16.
ALTER VIEW workflow_events_masked SET (security_invoker = true);

-- ── 3. The role's own read access to what that view selects ─────────────────
-- Column-level, matching migration 0009's allowlist discipline: raw metadata
-- is NOT granted here. The masked view redacts PII/financial values from
-- metadata at query time, and that redaction is only worth anything while the
-- raw column stays ungranted — otherwise the view is a formality the caller
-- can step around by selecting the base table directly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_user') THEN
    EXECUTE 'GRANT SELECT (id, tenant_id, workflow_id, instance_id, from_state, '
            'to_state, triggered_by, actor_id, comment, idempotency_key, created_at) '
            'ON workflow_events TO analytics_user';
  END IF;
END
$$;

-- ── Verification ────────────────────────────────────────────────────────────
-- Expect rolbypassrls = false, and reloptions containing security_invoker=true.
SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = 'analytics_user';
SELECT relname, reloptions FROM pg_class WHERE relname = 'workflow_events_masked';
