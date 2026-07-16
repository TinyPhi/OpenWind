-- analytics: excluded (index only — no new table)
-- down:
--   DROP INDEX IF EXISTS files_entity_clean_scan_idx;

-- Partial index to make per-entity clean-file listing fast.
-- The existing files_tenant_entity_idx covers (tenant_id, entity_id) for
-- general lookups; this filtered variant avoids scanning non-clean rows
-- when building the attachments list for a ticket.
--
-- NOT CONCURRENTLY: the migration runner (drizzle-orm's postgres-js migrator)
-- wraps every migration in a transaction, and CREATE INDEX CONCURRENTLY cannot
-- run inside one (PostgresError 25001). A brief write lock on `files` during
-- this index build is acceptable at this table's current size/pilot scale.
CREATE INDEX IF NOT EXISTS files_entity_clean_scan_idx
  ON files (tenant_id, entity_id, scan_status)
  WHERE scan_status = 'clean';
