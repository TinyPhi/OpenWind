-- ============================================================
-- Migration: 0079_extend_attachments_expiry_idx
-- perf(db): extend attachments_expiry_idx partial predicate to cover uploading status
-- ============================================================
--
-- DOWN MIGRATION (rollback):
-- DROP INDEX IF EXISTS "attachments_expiry_idx";
-- CREATE INDEX "attachments_expiry_idx" ON "attachments" ("upload_expires_at") WHERE status = 'pending';
--

DROP INDEX IF EXISTS "attachments_expiry_idx";

CREATE INDEX "attachments_expiry_idx"
  ON "attachments" ("upload_expires_at")
  WHERE "status" IN ('pending', 'uploading');
