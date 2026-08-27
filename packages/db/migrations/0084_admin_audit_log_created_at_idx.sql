-- Down migration:
-- DROP INDEX IF EXISTS "admin_audit_log_created_at_idx";

-- The access-log-retention sweep (apps/worker/src/access-log-retention.ts)
-- queries admin_audit_log with only a `created_at < X` predicate and no
-- tenant_id filter. The existing composite index (tenant_id, created_at DESC)
-- in migration 0011 cannot be used for that predicate because it leads on
-- tenant_id. Without this index, every sweep batch forces a full sequential
-- scan of the entire admin_audit_log table, which grows unbounded across all
-- tenants. This standalone created_at index gives the sweep an efficient entry
-- point. It complements -- does not replace -- the composite index used for
-- per-tenant reads.
CREATE INDEX "admin_audit_log_created_at_idx"
  ON "admin_audit_log" ("created_at");
