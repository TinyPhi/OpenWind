-- Down migration:
-- ALTER TABLE "tenants" DROP COLUMN "zitadel_org_id";

-- Maps a tenant to the Zitadel org whose users belong to it. Nullable because
-- existing/demo tenants may not have a real Zitadel org yet. Postgres UNIQUE
-- allows multiple NULLs, so this doesn't block more than one un-mapped tenant.
-- See docs/specs/tenant-org-id-mapping.md.
ALTER TABLE "tenants"
  ADD COLUMN "zitadel_org_id" text UNIQUE;
