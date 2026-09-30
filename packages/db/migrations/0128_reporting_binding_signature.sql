-- analytics: excluded (holds the reporting-binding signing key; no reporting value)
--
-- Reporting sessions (analytics_user) are scoped by settings that Superset's
-- connection mutator stamps at connect time: app.tenant_id, and for own-rows
-- sessions app.reporting_scope / app.reporting_user_id (migrations 0112, 0116).
-- Those are ordinary custom settings, and a session can change its own custom
-- settings at any time. With ad-hoc SQL (Stage 2), stamping alone therefore
-- cannot bind a session to its tenant.
--
-- This migration makes the binding verifiable. The mutator also stamps
-- app.reporting_binding_sig = HMAC-SHA256(key, tenant|scope|user_id), using a
-- secret only Superset and this database hold. Every table analytics_user can
-- read gets a RESTRICTIVE policy requiring tenant_id to equal
-- reporting_bound_tenant(), which recomputes the HMAC from the *current*
-- settings. Changing any of the three settings after connect, removing the
-- signature, or running without a key makes the function return NULL, so the
-- session sees zero rows: it fails closed. app_user is unaffected, because the
-- policies apply TO analytics_user only.
--
-- The key lives in reporting_binding_key and is synced from
-- REPORTING_BINDING_SECRET by the migration runner
-- (packages/db/src/run-migrations.ts). Nothing but the SECURITY DEFINER
-- function below can read it.
--
-- Rollback:
--   DROP POLICY IF EXISTS reporting_tenant_binding ON entity_instances;
--   DROP POLICY IF EXISTS reporting_tenant_binding ON workflow_events;
--   DROP POLICY IF EXISTS reporting_tenant_binding ON workflow_states;
--   DROP POLICY IF EXISTS reporting_tenant_binding ON tenant_users;
--   DROP POLICY IF EXISTS reporting_tenant_binding ON entity_types;
--   DROP POLICY IF EXISTS reporting_tenant_binding ON workflows;
--   CREATE OR REPLACE FUNCTION public.record_reporting_audit(...)  -- 0115 body
--   DROP FUNCTION IF EXISTS public.reporting_bound_tenant();
--   DROP TABLE IF EXISTS reporting_binding_key;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS reporting_binding_key (
    id         smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    secret     text        NOT NULL CHECK (length(secret) >= 32),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Default privileges (docker/postgres/init) grant new tables to app_user and
-- analytics_user; neither may read the key.
REVOKE ALL ON reporting_binding_key FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'REVOKE ALL ON reporting_binding_key FROM app_user';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_user') THEN
    EXECUTE 'REVOKE ALL ON reporting_binding_key FROM analytics_user';
  END IF;
END $$;

-- The session's tenant, but only when the signature over the current
-- tenant/scope/user settings verifies. NULL otherwise.
CREATE OR REPLACE FUNCTION public.reporting_bound_tenant()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_tenant text := NULLIF(current_setting('app.tenant_id', true), '');
    v_scope  text := COALESCE(NULLIF(current_setting('app.reporting_scope', true), ''), 'tenant');
    v_user   text := COALESCE(current_setting('app.reporting_user_id', true), '');
    v_sig    text := NULLIF(current_setting('app.reporting_binding_sig', true), '');
    v_secret text;
BEGIN
    IF v_tenant IS NULL OR v_sig IS NULL THEN
        RETURN NULL;
    END IF;
    SELECT secret INTO v_secret FROM reporting_binding_key WHERE id = 1;
    IF v_secret IS NULL THEN
        RETURN NULL;
    END IF;
    IF encode(hmac(v_tenant || '|' || v_scope || '|' || v_user, v_secret, 'sha256'), 'hex')
         IS DISTINCT FROM lower(v_sig) THEN
        RETURN NULL;
    END IF;
    RETURN v_tenant::uuid;
EXCEPTION
    -- A malformed tenant value must fail closed, not raise into the query.
    WHEN invalid_text_representation THEN
        RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.reporting_bound_tenant() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_user') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.reporting_bound_tenant() TO analytics_user';
  END IF;
END $$;

-- RESTRICTIVE, so it is ANDed with the existing tenant_read / own-rows policies.
-- `(SELECT …)` makes Postgres evaluate the function once per query, not per row.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_user') THEN
    EXECUTE $p$CREATE POLICY reporting_tenant_binding ON entity_instances AS RESTRICTIVE
      FOR SELECT TO analytics_user USING (tenant_id = (SELECT public.reporting_bound_tenant()))$p$;
    EXECUTE $p$CREATE POLICY reporting_tenant_binding ON workflow_events AS RESTRICTIVE
      FOR SELECT TO analytics_user USING (tenant_id = (SELECT public.reporting_bound_tenant()))$p$;
    EXECUTE $p$CREATE POLICY reporting_tenant_binding ON workflow_states AS RESTRICTIVE
      FOR SELECT TO analytics_user USING (tenant_id = (SELECT public.reporting_bound_tenant()))$p$;
    EXECUTE $p$CREATE POLICY reporting_tenant_binding ON tenant_users AS RESTRICTIVE
      FOR SELECT TO analytics_user USING (tenant_id = (SELECT public.reporting_bound_tenant()))$p$;
    -- Platform-global rows (tenant_id IS NULL) stay readable, as tenant_*_read already allows.
    EXECUTE $p$CREATE POLICY reporting_tenant_binding ON entity_types AS RESTRICTIVE
      FOR SELECT TO analytics_user USING (tenant_id IS NULL OR tenant_id = (SELECT public.reporting_bound_tenant()))$p$;
    EXECUTE $p$CREATE POLICY reporting_tenant_binding ON workflows AS RESTRICTIVE
      FOR SELECT TO analytics_user USING (tenant_id IS NULL OR tenant_id = (SELECT public.reporting_bound_tenant()))$p$;
  END IF;
END $$;

-- The audit writer trusted the raw app.tenant_id setting; it now requires the
-- verified binding. Body otherwise as in 0115.
CREATE OR REPLACE FUNCTION public.record_reporting_audit(
    p_tenant_id uuid,
    p_actor_id  text,
    p_action    text,
    p_metadata  jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_session_tenant uuid := public.reporting_bound_tenant();
BEGIN
    IF p_action NOT IN (
        'reporting.query_executed',
        'reporting.exported'
    ) THEN
        RAISE EXCEPTION 'record_reporting_audit: unsupported action %', p_action;
    END IF;

    -- NULL when the connection carries no tenant, or its binding signature does
    -- not verify against the current settings.
    IF v_session_tenant IS NULL THEN
        RAISE EXCEPTION 'record_reporting_audit: no verified session tenant';
    END IF;
    IF p_tenant_id IS DISTINCT FROM v_session_tenant THEN
        RAISE EXCEPTION 'record_reporting_audit: tenant does not match the session tenant';
    END IF;

    INSERT INTO admin_audit_log (
        tenant_id, actor_id, actor_type, resource_type, resource_id,
        action, metadata
    ) VALUES (
        v_session_tenant,
        p_actor_id,
        'user',
        'reporting',
        gen_random_uuid(),
        p_action,
        COALESCE(p_metadata, '{}'::jsonb)
    );
END;
$$;
