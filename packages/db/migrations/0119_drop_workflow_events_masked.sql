-- Remove the masked view. It has never worked, and it cannot.
--
-- The contradiction. Migration 0112 set security_invoker = true on
-- workflow_events_masked, which is correct and load-bearing: without it the view
-- ran as its owner, migration_user, which owns the base tables and holds
-- BYPASSRLS, so the view was a hole straight through tenant isolation. 0112
-- measured it — a tenant owning none of the rows got 0 from the base table and
-- all 48 through the view.
--
-- But invoker semantics mean the caller's own privileges are checked against
-- every object the view touches. This view reads `metadata` in order to redact
-- it, and joins entity_fields to find which fields are marked pii or financial.
-- So an analyst can use the view only while holding SELECT on the very column it
-- exists to hide, and on a table nobody ever granted them.
--
-- The result is that it has never returned a row to an analyst:
--
--   after 0112   metadata ungranted        -> fails on `metadata`
--   after 0113   metadata granted (table)  -> fails on `entity_fields`
--
-- Verified on this database: `permission denied for table entity_fields`, and
-- has_table_privilege(analytics_user, entity_fields, SELECT) is false. No chart
-- references it (0 slices), and no application code outside the migrations and
-- Superset provisioning mentions it.
--
-- Why delete rather than repair. Repairing it means granting `metadata` back,
-- which is the exposure migration 0118 just closed. The only other route is
-- owner-evaluated privileges, which walks back into 0112's incident. Neither is
-- acceptable, so the object goes.
--
-- Masking is not lost — it is replaced by something stronger. Redaction hides
-- values inside a column the caller can still read; exclusion means the column
-- is never granted at all. After 0117 and 0118 reporting classifies events
-- through `event_type` and cannot reach the payload by any path. ADR-001 is
-- amended to describe exclusion rather than redaction.
--
-- Note for a fresh build: migrations 0009 and 0017 create this view, so a
-- from-scratch run creates it and then drops it here. That is intended. Pointer
-- comments were added to both so the next reader is not left guessing.
--
-- Rollback (recreates the view as 0017 defined it, in the state where it does
-- not work — provided only for completeness):
--   see packages/db/migrations/0017_workflow_events_actor_id_text.sql

BEGIN;

DROP VIEW IF EXISTS workflow_events_masked;

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
-- Expect zero rows.
--
--   SELECT 1 FROM pg_views WHERE viewname = 'workflow_events_masked';
