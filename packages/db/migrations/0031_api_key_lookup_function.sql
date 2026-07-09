-- analytics: excluded (function, not a table)
--
-- Fix: resolveApiKey (packages/auth/src/middleware.ts) looks up api_keys by
-- key_hash BEFORE it knows which tenant the key belongs to -- that's the whole
-- point of the lookup. Since migration 0021 (#121) started enforcing RLS via
-- SET LOCAL ROLE app_user for real, api_keys' tenant_read policy blocks this
-- lookup unconditionally: app.tenant_id is never set at this point, so the
-- query returns zero rows for every valid key, for every tenant, always.
--
-- Fix: a narrowly-scoped SECURITY DEFINER function, callable only by app_user,
-- that looks up a single row by exact key_hash match and returns only the
-- three columns the caller needs (never key_hash itself). This is the standard
-- "lookup by secret token" RLS escape hatch: key_hash IS the credential -- an
-- attacker who already has the hash already has the raw key, so this bypass
-- doesn't create a real cross-tenant read (nothing else lets you query by
-- key_hash without already possessing it). Ownership by the migration-running
-- role (not app_user) means the function body bypasses RLS on api_keys, since
-- api_keys has no FORCE ROW LEVEL SECURITY set.
--
-- Rollback:
--   REVOKE EXECUTE ON FUNCTION resolve_api_key_by_hash(text) FROM app_user;
--   DROP FUNCTION resolve_api_key_by_hash(text);

CREATE FUNCTION resolve_api_key_by_hash(p_key_hash text)
RETURNS TABLE (id uuid, tenant_id uuid, scopes text[])
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, tenant_id, scopes
  FROM api_keys
  WHERE key_hash = p_key_hash
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION resolve_api_key_by_hash(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT EXECUTE ON FUNCTION resolve_api_key_by_hash(text) TO app_user;
  END IF;
END
$$;
