-- analytics: excluded (remark col: free-text user content, excluded per audit/files
-- pattern for unstructured user content)
--
-- Adds the `remark` system field to entity_instances (mandatory-ticket-fields sync,
-- 2026-09-21) -- same shape as the existing due_date (migration 0052) and severity
-- (migration 0108) system columns: a plain, nullable TEXT column, not an entity_fields
-- row, so every workflow's create form gets the same "Remark" box without per-module
-- seed changes. NULL on rows created before this feature (no DB-level DEFAULT, same
-- rationale as severity's own migration comment -- an ADD COLUMN DEFAULT would
-- silently backfill every existing row and violate the "NULL means predates this
-- feature" invariant). Mandatory-at-creation is enforced at the application layer
-- (the create-route Zod schemas), never as a NOT NULL DB constraint.
--
-- Rollback (undoes only what THIS migration added):
--   ALTER TABLE entity_instances DROP COLUMN remark;

ALTER TABLE entity_instances
  ADD COLUMN remark TEXT;
