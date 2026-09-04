-- analytics: excluded (index only, no new table)
--
-- Admin-UI API Keys restructuring: keys are grouped into one card per
-- application by application_name. Without a real applications table, that
-- grouping is only trustworthy if application_name is actually unique per
-- tenant (normalized) -- otherwise a stray whitespace/case difference would
-- silently split one application into two cards, or two genuinely different
-- registrations could collide under one name. Enforced at the DB layer
-- (not just create.ts's own pre-check) for the same reason
-- api_keys_oidc_client_id_active_unique (migration 0068) exists alongside
-- create.ts's own conflict check: a pre-check alone can't close the race
-- between two concurrent creates.
--
-- Scoped to (tenant_id, normalized name) -- unlike the OIDC Client ID index,
-- which is deliberately global (a Client ID identifies one external
-- application everywhere), an application NAME is just a human label two
-- different tenants can legitimately reuse for their own separate
-- registrations.
--
-- WHERE revoked_at IS NULL AND application_name IS NOT NULL, matching
-- 0068's own partial-index shape: a revoked key's name becomes reusable,
-- and role-format keys (application_name always NULL) never participate.
--
-- Down migration:
-- DROP INDEX IF EXISTS "api_keys_tenant_application_name_active_unique";

CREATE UNIQUE INDEX "api_keys_tenant_application_name_active_unique"
  ON "api_keys" (tenant_id, lower(btrim(application_name)))
  WHERE revoked_at IS NULL AND application_name IS NOT NULL;
