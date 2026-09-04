-- analytics: excluded (column + index changes only, no new table)
--
-- Fixes a real regression migration 0087 introduced: rotate.ts (ADR-012
-- Phase A, migration 0069/0072) deliberately keeps a rotated key's
-- PREDECESSOR row active (revoked_at untouched) for a 24h grace window while
-- the new successor row is inserted with the SAME application_name -- by
-- design, since it's still the same application, just a new credential.
-- Migration 0087's plain (tenant_id, normalized name) unique index has no
-- way to allow that intentional one-name/two-active-rows overlap, so every
-- graceful rotation of a third-party key started failing with
-- api_keys_tenant_application_name_active_unique violations.
--
-- Fixed the same way oidc_client_id_active (migration 0072) already solves
-- the identical problem for the Client ID index: a boolean "active claim
-- holder" flag, defaulting true, that rotate.ts flips to false on the
-- predecessor in the same update that already flips oidc_client_id_active
-- to false -- exactly one row per application ever holds the name's
-- uniqueness claim, even while two rows are briefly both non-revoked.
--
-- Down migration:
-- DROP INDEX IF EXISTS "api_keys_tenant_application_name_active_unique";
-- CREATE UNIQUE INDEX "api_keys_tenant_application_name_active_unique"
--   ON "api_keys" (tenant_id, lower(btrim(application_name)))
--   WHERE revoked_at IS NULL AND application_name IS NOT NULL;
-- ALTER TABLE "api_keys" DROP COLUMN "application_name_active";

ALTER TABLE "api_keys"
  ADD COLUMN "application_name_active" boolean NOT NULL DEFAULT true;

DROP INDEX IF EXISTS "api_keys_tenant_application_name_active_unique";

CREATE UNIQUE INDEX "api_keys_tenant_application_name_active_unique"
  ON "api_keys" (tenant_id, lower(btrim(application_name)))
  WHERE revoked_at IS NULL
    AND application_name IS NOT NULL
    AND application_name_active = true;
