-- analytics: excluded (no new table — column additions only)
--
-- docs/specs/third-party-key-external-org-mapping.md: a third-party API key
-- can trust acting-person tokens from an IdP/org different from the
-- tenant's primary login IdP (tenants.zitadel_org_id, one column, one
-- mapping per tenant -- see docs/specs/tenant-org-id-mapping.md). Both new
-- columns are nullable and only ever used together: NULL/NULL means "this
-- key uses the tenant's primary IdP mapping," today's default behavior,
-- completely unchanged. The creation-time validation that enforces they're
-- supplied together (and only when actually needed) lives in
-- apps/api/src/routes/api-keys/create.ts, not here -- same pattern as
-- migration 0068's applicationName/applicationContactEmail/oidcClientId,
-- which are also nullable at the DB layer with the real "required for this
-- flow" enforcement at the API layer.
--
-- Down migration:
-- ALTER TABLE "api_keys" DROP COLUMN "external_issuer";
-- ALTER TABLE "api_keys" DROP COLUMN "external_org_id";

ALTER TABLE "api_keys"
  ADD COLUMN "external_issuer" text,
  ADD COLUMN "external_org_id" text;
