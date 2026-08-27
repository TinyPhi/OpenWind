-- ============================================================
-- Migration: 0082_idempotency_keys
-- ADR-012 Phase G, spec R3/R4/R5/R10 -- idempotency-key support for
-- create/comment/sub-ticket/transition third-party routes. Scoped to the
-- 3-tuple (tenant_id, api_key_id, acting_person_id) together with the
-- caller-supplied idempotency_key string, never a 2-tuple or global lookup
-- (spec invariant).
-- ============================================================
--
-- DOWN MIGRATION (rollback):
-- DROP POLICY IF EXISTS "idempotency_keys_tenant_isolation" ON "idempotency_keys";
-- ALTER TABLE "idempotency_keys" DISABLE ROW LEVEL SECURITY;
-- DROP INDEX IF EXISTS "idempotency_keys_expires_idx";
-- DROP TABLE IF EXISTS "idempotency_keys";
--
-- analytics: excluded (response_body can contain full ticket/comment
--            content, including PII -- a cache of in-flight request
--            results, not a durable business record; spec R10 requires
--            tenant-purge to delete these rows outright, not anonymize)

CREATE TABLE "idempotency_keys" (
  "id"                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"         uuid        NOT NULL,
  "api_key_id"        uuid        NOT NULL,
  "acting_person_id"  text        NOT NULL,
  "idempotency_key"   text        NOT NULL,
  -- RFC 8785 JSON Canonicalization Scheme hash of the request body -- lets a
  -- same-key-different-content retry be rejected as a conflict (spec R4)
  -- without storing the full request body twice.
  "content_hash"      text        NOT NULL,
  "response_status"   integer     NOT NULL,
  "response_body"     jsonb       NOT NULL,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  -- 24h result-cache TTL (spec R3). Sweeping expired rows is a plain
  -- age-based query (created_at/expires_at), not a scheduled job in this
  -- migration -- see the idempotency helper module for the read path.
  "expires_at"        timestamptz NOT NULL,
  CONSTRAINT "idempotency_keys_scope_unique"
    UNIQUE ("tenant_id", "api_key_id", "acting_person_id", "idempotency_key")
);

-- Sweep/cleanup lookup: expired rows for a tenant (also used by tenant-purge,
-- spec R10, though that path deletes unconditionally by tenant_id).
CREATE INDEX "idempotency_keys_expires_idx"
  ON "idempotency_keys" ("expires_at");

ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "idempotency_keys_tenant_isolation"
  ON "idempotency_keys"
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'GRANT SELECT, INSERT, DELETE ON idempotency_keys TO app_user';
  END IF;
END
$$;
