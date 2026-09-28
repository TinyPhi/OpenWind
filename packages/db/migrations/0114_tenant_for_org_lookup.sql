-- One function so Superset can turn a Zitadel org id into a tenant id.
--
-- Stage 2 logs analysts in with Zitadel. Their claims carry an org id, but
-- row-level security needs the tenant UUID, and the mapping lives in `tenants`
-- — a table migration 0113 deliberately took away from the reporting role
-- because it has no tenant column of its own and so returns every row to
-- anyone who can read it.
--
-- Granting the table back to make login work would undo that repair. Instead
-- this exposes the single question Stage 2 actually needs answered, and nothing
-- else: given one org id, which tenant is it. No listing, no enumeration of
-- other tenants, no columns beyond the id.
--
-- SECURITY DEFINER so it runs as the owner, which can read `tenants`, while the
-- caller still cannot. search_path is pinned because a SECURITY DEFINER
-- function that resolves names through the caller's search_path can be made to
-- execute the caller's code as the owner.
--
-- It returns NULL for an unknown org rather than raising: the caller's job is
-- to refuse a login with no tenant, and NULL is the value that makes that check
-- obvious at the call site.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS public.tenant_for_org(text);

BEGIN;

CREATE OR REPLACE FUNCTION public.tenant_for_org(p_org_id text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT id FROM tenants WHERE zitadel_org_id = p_org_id LIMIT 1;
$$;

-- EXECUTE only, and only for the reporting role. The function body reads
-- `tenants`; the grantee still cannot. Guarded because the role comes from
-- docker/postgres/init, not a migration (same convention as 0009).
REVOKE ALL ON FUNCTION public.tenant_for_org(text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_user') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.tenant_for_org(text) TO analytics_user';
  END IF;
END
$$;

COMMIT;
