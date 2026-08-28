-- ============================================================
-- Migration: 0077_attachments
-- ADR-012 Phase D, spec R1/R2/R3/R8 — third-party API file attachments.
-- Tracks the presign -> upload -> ticket-binding lifecycle ahead of the
-- actual file bytes landing in the `files` table (that FK is nullable
-- until upload completes).
-- ============================================================
--
-- DOWN MIGRATION (rollback):
-- DROP POLICY IF EXISTS "attachments_tenant_isolation" ON "attachments";
-- ALTER TABLE "attachments" DISABLE ROW LEVEL SECURITY;
-- DROP INDEX IF EXISTS "attachments_tenant_status_idx";
-- DROP INDEX IF EXISTS "attachments_tenant_ticket_idx";
-- DROP INDEX IF EXISTS "attachments_expiry_idx";
-- DROP TABLE IF EXISTS "attachments";
--
-- analytics: excluded (declared_filename may contain PII; tracks an
--            in-progress upload lifecycle, not a durable business record)

CREATE TABLE "attachments" (
  "id"                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"            uuid        NOT NULL,
  -- Nullable: unbound until the first successful ticket/comment reference
  -- (spec R3 — an attachment presigned without a ticketId, for the
  -- create-time-attach case, starts unbound).
  "ticket_id"            uuid,
  "bound_at"             timestamptz,
  "uploaded_by"          text        NOT NULL,  -- literal 'api_key' (channel descriptor, matches workflow_events.triggered_by convention)
  "acting_person_id"     text        NOT NULL,
  "declared_filename"    text        NOT NULL,
  "declared_size_bytes"  bigint      NOT NULL CHECK ("declared_size_bytes" > 0),
  "declared_mime_type"   text        NOT NULL,
  -- sha256 of the single-use upload token — never store the raw token,
  -- same pattern as api_keys.key_hash.
  "upload_token_hash"    text        NOT NULL,
  "upload_expires_at"    timestamptz NOT NULL,
  -- Set once the PUT completes; a nullable FK is the "has upload completed"
  -- signal (spec R3 — referencing an ID whose upload never completed is 422).
  "files_id"             uuid        REFERENCES "files"("id"),
  -- pending (presigned, not yet uploaded) | uploading (atomically claimed
  -- by one in-flight PUT -- closes the TOCTOU race where two concurrent
  -- PUTs could otherwise both pass a read-only status check) | uploaded
  -- (files_id set) | expired (slot TTL passed, never uploaded)
  "status"               text        NOT NULL DEFAULT 'pending'
                                      CONSTRAINT "attachments_status_check"
                                      CHECK ("status" IN ('pending', 'uploading', 'uploaded', 'expired')),
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now()
);

-- Lookup: all attachments bound to a ticket (reference-time cross-checks, R3)
CREATE INDEX "attachments_tenant_ticket_idx"
  ON "attachments" ("tenant_id", "ticket_id")
  WHERE "ticket_id" IS NOT NULL;

-- Lookup: presign-status attachments for a tenant (quota/count checks)
CREATE INDEX "attachments_tenant_status_idx"
  ON "attachments" ("tenant_id", "status");

-- Lookup: expired-but-still-pending slots for the cleanup job (T2)
CREATE INDEX "attachments_expiry_idx"
  ON "attachments" ("upload_expires_at")
  WHERE "status" = 'pending';

ALTER TABLE "attachments" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "attachments_tenant_isolation"
  ON "attachments"
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON attachments TO app_user';
  END IF;
END
$$;
