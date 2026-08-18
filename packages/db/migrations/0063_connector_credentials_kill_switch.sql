-- analytics: excluded (no new table — column additions only)
--
-- Issue #367 (ADR-009 Decision #9's "existing kill-switch precedent" note):
-- a live-flippable, non-destructive disable for a specific (tenant_id,
-- connector_id) installation, distinct from install/uninstall. Mirrors
-- api_keys' revoked_at/revoked_by soft-revoke shape (migration 0053) rather
-- than a bare boolean — a timestamp doubles as the audit signal for "when",
-- with the actor recorded alongside it, at no extra cost over a boolean.
--
-- Both columns are nullable and additive — no existing read/write path
-- breaks. NULL means enabled (current behavior, unchanged for every
-- existing row).
--
-- Rollback:
--   ALTER TABLE connector_credentials DROP COLUMN disabled_at;
--   ALTER TABLE connector_credentials DROP COLUMN disabled_by;

ALTER TABLE connector_credentials ADD COLUMN disabled_at timestamptz;
ALTER TABLE connector_credentials ADD COLUMN disabled_by text;
