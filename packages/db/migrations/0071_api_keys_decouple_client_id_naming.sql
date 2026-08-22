-- Decouple OIDC client ID column from Zitadel naming (Issue #444)
-- Rename zitadel_client_id and zitadel_client_id_active columns, and drop/recreate index.
--
-- Rollback:
--   DROP INDEX IF EXISTS api_keys_oidc_client_id_active_unique;
--   CREATE UNIQUE INDEX api_keys_zitadel_client_id_active_unique ON api_keys (zitadel_client_id) WHERE revoked_at IS NULL AND zitadel_client_id_active = true AND zitadel_client_id IS NOT NULL;
--   ALTER TABLE api_keys RENAME COLUMN oidc_client_id TO zitadel_client_id;
--   ALTER TABLE api_keys RENAME COLUMN oidc_client_id_active TO zitadel_client_id_active;

ALTER TABLE api_keys RENAME COLUMN zitadel_client_id TO oidc_client_id;
ALTER TABLE api_keys RENAME COLUMN zitadel_client_id_active TO oidc_client_id_active;

DROP INDEX IF EXISTS api_keys_zitadel_client_id_active_unique;

CREATE UNIQUE INDEX api_keys_oidc_client_id_active_unique ON api_keys (oidc_client_id)
  WHERE revoked_at IS NULL AND oidc_client_id_active = true AND oidc_client_id IS NOT NULL;