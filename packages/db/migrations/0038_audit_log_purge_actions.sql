-- Down migration:
-- ALTER TABLE admin_audit_log DROP CONSTRAINT audit_log_action_check;
-- ALTER TABLE admin_audit_log
--   ADD CONSTRAINT audit_log_action_check
--   CHECK (action IN ('created', 'updated', 'deleted', 'transitioned', 'restored'));

-- Found while writing the ADR-007 regression test for tenant-purge.ts (migration
-- 0037): apps/worker/src/tenant-purge.ts writes 'purge.completed'/'purge.failed'
-- audit entries (added for G5, tenant purge compliance logging), but neither
-- value was ever added to this table's action allowlist (0011_admin_audit_log.sql).
-- Every real tenant purge has been throwing on this write — the deletion and the
-- tenant.status = 'purged' update both already succeed by that point, so data is
-- correctly purged, but the completion/failure audit entry silently never gets
-- written, and the BullMQ job shows as failed even though the purge substantively
-- succeeded. Unrelated to RLS; found and fixed alongside ADR-007's regression test
-- since that test is what first exercised this path against a real database.

ALTER TABLE admin_audit_log DROP CONSTRAINT audit_log_action_check;

ALTER TABLE admin_audit_log
  ADD CONSTRAINT audit_log_action_check
  CHECK (action IN ('created', 'updated', 'deleted', 'transitioned', 'restored', 'purge.completed', 'purge.failed'));
