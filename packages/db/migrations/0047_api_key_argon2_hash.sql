-- analytics: excluded (no new table — column addition only)
--
-- Add key_hash_argon2 column to api_keys so newly-created keys are stored with
-- an argon2id hash for offline-attack resistance, alongside the existing SHA-256
-- lookup hash.  The column is nullable so existing keys remain valid during the
-- migration; they pass on SHA-256 match alone until they are regenerated.
--
-- Also replaces resolve_api_key_by_hash to return the new column so the app
-- layer can verify the raw key against argon2id without loading libargon2 in
-- the DB process.
--
-- Rollback:
--   CREATE OR REPLACE FUNCTION resolve_api_key_by_hash(p_key_hash text)
--   RETURNS TABLE (id uuid, tenant_id uuid, scopes text[])
--   LANGUAGE sql SECURITY DEFINER SET search_path = public
--   AS $$ SELECT id, tenant_id, scopes FROM api_keys WHERE key_hash = p_key_hash LIMIT 1; $$;
--   ALTER TABLE api_keys DROP COLUMN key_hash_argon2;

ALTER TABLE api_keys ADD COLUMN key_hash_argon2 text;

CREATE OR REPLACE FUNCTION resolve_api_key_by_hash(p_key_hash text)
RETURNS TABLE (id uuid, tenant_id uuid, scopes text[], key_hash_argon2 text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, tenant_id, scopes, key_hash_argon2
  FROM api_keys
  WHERE key_hash = p_key_hash
  LIMIT 1;
$$;
