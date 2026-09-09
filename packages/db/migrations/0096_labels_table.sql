-- ============================================================
-- Migration: 0096_labels_table
-- docs/specs/oncall-routing.md T34, R1b -- 3E on-call routing, Phase 1
-- ============================================================
--
-- DOWN MIGRATION (rollback):
-- DROP POLICY IF EXISTS "tenant_write" ON "labels";
-- DROP POLICY IF EXISTS "tenant_read" ON "labels";
-- ALTER TABLE "labels" DISABLE ROW LEVEL SECURITY;
-- DROP INDEX IF EXISTS "labels_tenant_name_unique";
-- DROP INDEX IF EXISTS "labels_tenant_idx";
-- DROP TABLE IF EXISTS "labels";
--
-- analytics: included (id, tenant_id, name, color, created_at)
--
-- GitHub-style tenant-managed label vocabulary (ADR-016 Decision 3) --
-- replaces the earlier free-text `tags` multi_select field design (OQ-2,
-- resolved). color is required (hex string, format validated at the
-- application layer -- Zod, not a DB CHECK, matching this repo's usual
-- validate-at-the-boundary pattern for non-tenant-isolation invariants).

CREATE TABLE "labels" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"   uuid NOT NULL REFERENCES tenants(id),
  "name"        text NOT NULL,
  "color"       text NOT NULL,
  "description" text,
  "created_by"  text NOT NULL, -- Zitadel JWT sub claim, not a local uuid PK
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  "deleted_at"  timestamptz
);

CREATE INDEX "labels_tenant_idx" ON "labels" ("tenant_id");

-- Soft-deleted rows free their name for reuse (R1b: duplicate name within a
-- tenant returns 409 -- enforced only against still-live rows).
CREATE UNIQUE INDEX "labels_tenant_name_unique"
  ON "labels" ("tenant_id", "name")
  WHERE "deleted_at" IS NULL;

ALTER TABLE "labels" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_read" ON "labels"
  FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "tenant_write" ON "labels"
  FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON labels TO app_user';
  END IF;
END
$$;
