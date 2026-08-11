-- analytics: excluded (no new table — column additions + function replace only)
--
-- ADR-008 Decisions #2-4: close three real gaps in the api_key principal that
-- exists and is in use today (agent/delegation identity is deferred separately,
-- see ADR-008 Decision #5 — unrelated to this migration):
--
--   #2 — api_keys had no created_by column and key creation wrote no audit
--        entry, so the audit trail's "traces back to a human" claim was
--        already false for api_key today, not a hypothetical future gap.
--   #3 — api_keys had no expires_at and no rotation support: sk_ keys were
--        immortal bearer secrets.
--   #4 — revocation hard-deleted the row, destroying the forensic record
--        (last_used_at, when the key existed) an incident investigation needs.
--
-- All five new columns are nullable and additive — no existing read/write path
-- breaks. Existing keys get expires_at = NULL (unaffected until a future,
-- separately-confirmed migration decision — see ADR-008 OQ-2/OQ-3, both still
-- open pending sign-off on exact grace-period windows, deliberately NOT
-- implemented here).
--
-- resolve_api_key_by_hash is replaced (not just column-added) so revoked and
-- expired keys stop authenticating at the same lookup that already excludes
-- unknown hashes — a revoked/expired key now fails exactly like an unknown
-- key (no distinct signal that would let a caller infer the key ever existed).
--
-- Rollback:
--   DROP FUNCTION IF EXISTS resolve_api_key_by_hash(text);
--   CREATE FUNCTION resolve_api_key_by_hash(p_key_hash text)
--   RETURNS TABLE (id uuid, tenant_id uuid, scopes text[], key_hash_argon2 text)
--   LANGUAGE sql SECURITY DEFINER SET search_path = public
--   AS $$ SELECT id, tenant_id, scopes, key_hash_argon2 FROM api_keys
--         WHERE key_hash = p_key_hash LIMIT 1; $$;
--   REVOKE ALL ON FUNCTION resolve_api_key_by_hash(text) FROM PUBLIC;
--   DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
--     GRANT EXECUTE ON FUNCTION resolve_api_key_by_hash(text) TO app_user;
--   END IF; END $$;
--   ALTER TABLE api_keys DROP COLUMN created_by;
--   ALTER TABLE api_keys DROP COLUMN expires_at;
--   ALTER TABLE api_keys DROP COLUMN revoked_at;
--   ALTER TABLE api_keys DROP COLUMN revoked_by;
--   ALTER TABLE api_keys DROP COLUMN rotated_from;

ALTER TABLE api_keys ADD COLUMN created_by text;
ALTER TABLE api_keys ADD COLUMN expires_at timestamptz;
ALTER TABLE api_keys ADD COLUMN revoked_at timestamptz;
ALTER TABLE api_keys ADD COLUMN revoked_by text;
ALTER TABLE api_keys ADD COLUMN rotated_from uuid REFERENCES api_keys(id);

-- PostgreSQL does not allow CREATE OR REPLACE FUNCTION to change a return type.
-- Drop first so the same 4-column signature can be created cleanly with the
-- new WHERE filter (return shape is unchanged from migration 0047).
DROP FUNCTION IF EXISTS resolve_api_key_by_hash(text);

CREATE FUNCTION resolve_api_key_by_hash(p_key_hash text)
RETURNS TABLE (id uuid, tenant_id uuid, scopes text[], key_hash_argon2 text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, tenant_id, scopes, key_hash_argon2
  FROM api_keys
  WHERE key_hash = p_key_hash
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > now())
  LIMIT 1;
$$;

-- Re-apply the same permission grants that migrations 0031/0047 set.
REVOKE ALL ON FUNCTION resolve_api_key_by_hash(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT EXECUTE ON FUNCTION resolve_api_key_by_hash(text) TO app_user;
  END IF;
END
$$;
