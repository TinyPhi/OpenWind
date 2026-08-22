-- analytics: excluded (no new table — column additions only)
--
-- ADR-012 Phase A (Third-Party API — Rotate, PR A3): closes a real conflict
-- between two things migration 0068 and rotation each need, discovered while
-- implementing Rotate for third-party keys:
--
-- - Rotation's whole point is that the OLD key keeps authenticating for a
--   24h grace window (revoked_at stays NULL on purpose — see ADR-008
--   Decision #3 and rotate.ts) while the NEW key is active immediately. For
--   a third-party key, both rows need the SAME zitadel_client_id, since
--   they represent the same external application, just old and new
--   credentials for it.
-- - Migration 0068's partial unique index enforces "at most one non-revoked
--   row per zitadel_client_id" — which was designed to stop two *different*
--   applications from colliding on one Client ID at mint time, but has no
--   way to tell that apart from "the same application's planned handover
--   during rotation." As written, rotating any third-party key would hit
--   that unique-violation immediately.
--
-- Resolved by adding a dedicated boolean, orthogonal to revoked_at: whichever
-- row currently "holds" the Client ID for uniqueness purposes has this set
-- true; the other (the dying predecessor, mid-grace) has it set false. The
-- dying row keeps its zitadel_client_id *value* unchanged (so a future
-- Phase B `aud` check, or anything else that reads it, still sees the
-- correct application identity for that still-authenticating credential) —
-- only its claim on *uniqueness* is released. Every existing key defaults to
-- true (no existing row's behavior changes); the rotate endpoint is the only
-- code path that ever sets this false, explicitly, on the predecessor, in
-- the same transaction that inserts the successor (already true by column
-- default).
--
-- Migration 0068's index is dropped and recreated rather than altered in
-- place — Postgres has no ALTER INDEX ... ADD PREDICATE.
--
-- Rollback:
--   DROP INDEX IF EXISTS api_keys_zitadel_client_id_active_unique;
--   CREATE UNIQUE INDEX api_keys_zitadel_client_id_active_unique
--     ON api_keys (zitadel_client_id)
--     WHERE revoked_at IS NULL AND zitadel_client_id IS NOT NULL;
--   ALTER TABLE api_keys DROP COLUMN zitadel_client_id_active;

ALTER TABLE api_keys ADD COLUMN zitadel_client_id_active boolean NOT NULL DEFAULT true;

DROP INDEX api_keys_zitadel_client_id_active_unique;

CREATE UNIQUE INDEX api_keys_zitadel_client_id_active_unique
  ON api_keys (zitadel_client_id)
  WHERE revoked_at IS NULL
    AND zitadel_client_id_active = true
    AND zitadel_client_id IS NOT NULL;
