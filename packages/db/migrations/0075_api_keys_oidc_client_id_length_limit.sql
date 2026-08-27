-- analytics: excluded (no new table — constraint addition / rename only)
--
-- Issue #474: Migration 0071 added `api_keys_zitadel_client_id_length` on
-- `zitadel_client_id`. Migration 0072 renamed `zitadel_client_id` to
-- `oidc_client_id`.
-- On any database where 0072 was applied before 0071 (or where 0071 was skipped
-- due to journal timestamps), 0071 could not run against the post-rename column.
--
-- This forward migration ensures that the length constraint is consistently
-- named `api_keys_oidc_client_id_length` and enforced across all environments:
-- 1. If `api_keys_zitadel_client_id_length` exists (from 0071 running prior to 0072),
--    rename it to `api_keys_oidc_client_id_length`.
-- 2. If neither exists (from environments where 0071 was skipped), add
--    `api_keys_oidc_client_id_length CHECK (char_length(oidc_client_id) <= 200)`.
-- 3. If `api_keys_oidc_client_id_length` already exists, no-op.
--
-- Rollback:
-- This migration's effect depends on which branch ran, so a blind DROP is only
-- correct for State B. Check whether 0071's timestamp (1785542423000) is in
-- __drizzle_migrations to tell them apart:
--
-- State B (ADD CONSTRAINT path — 0071 was skipped, constraint did not exist before 0075):
--   ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_oidc_client_id_length;
--
-- State A (RENAME CONSTRAINT path — 0071 ran before 0072, constraint existed under the
-- old name): rolling back must restore that old name, not drop the constraint outright —
-- dropping it here would leave the column with no length check at all, which is worse
-- than the pre-0075 state.
--   ALTER TABLE api_keys
--     RENAME CONSTRAINT api_keys_oidc_client_id_length TO api_keys_zitadel_client_id_length;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'api_keys_zitadel_client_id_length'
      AND conrelid = 'public.api_keys'::regclass
  ) THEN
    ALTER TABLE api_keys
      RENAME CONSTRAINT api_keys_zitadel_client_id_length TO api_keys_oidc_client_id_length;
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'api_keys_oidc_client_id_length'
      AND conrelid = 'public.api_keys'::regclass
  ) THEN
    ALTER TABLE api_keys
      ADD CONSTRAINT api_keys_oidc_client_id_length
      CHECK (char_length(oidc_client_id) <= 200);
  END IF;
END $$;
