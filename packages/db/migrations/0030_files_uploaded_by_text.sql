-- analytics: excluded (schema fix — no analytical value)
--
-- Fix: files.uploaded_by was incorrectly typed as uuid.
-- Zitadel JWT sub claims are numeric strings (e.g. "378676040483995650"), not UUIDs.
-- Alter to text so the INSERT doesn't fail on every file upload.
--
-- Rollback:
--   ALTER TABLE files ALTER COLUMN uploaded_by TYPE uuid USING uploaded_by::uuid;
--   (only safe if all stored values happen to be valid UUIDs — they won't be after this migration runs)

ALTER TABLE files ALTER COLUMN uploaded_by TYPE text;
