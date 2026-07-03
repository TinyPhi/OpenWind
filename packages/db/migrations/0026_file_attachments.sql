-- analytics: excluded (index only — no new table)
-- down:
--   DROP INDEX CONCURRENTLY IF EXISTS files_entity_clean_scan_idx;

-- Partial index to make per-entity clean-file listing fast.
-- The existing files_tenant_entity_idx covers (tenant_id, entity_id) for
-- general lookups; this filtered variant avoids scanning non-clean rows
-- when building the attachments list for a ticket.
CREATE INDEX CONCURRENTLY IF NOT EXISTS files_entity_clean_scan_idx
  ON files (tenant_id, entity_id, scan_status)
  WHERE scan_status = 'clean';
