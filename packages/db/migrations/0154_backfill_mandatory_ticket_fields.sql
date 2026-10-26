-- analytics: excluded (data backfill on existing entity_instances rows only -- no new table)
--
-- docs/specs/mandatory-ticket-fields.md R9 (PR 2.5). Every workflow record carries title, due
-- date, remark and severity. Records created before the rule (or by a path the "log" mode
-- reported) get the agreed defaults, once, so MANDATORY_FIELDS_MODE can default to "enforce":
--   title     -> 'Untitled ticket #<first 8 characters of the id>'
--   due_date  -> created_at + 7 days
--   remark    -> 'Backfilled: no remark was recorded when this ticket was created.'
--   severity  -> 'medium'
-- A workflow record has a workflow_id (sub-tasks inherit their parent's), or its entity type
-- has an active workflow (the engine's own test, mandatory-refs.ts). A value already present is
-- never changed, updated_at is left alone (this isn't anyone's edit), and records outside
-- workflows are untouched. Re-running it changes nothing.
--
-- Check afterwards (expect 0):
--   SELECT count(*) FROM entity_instances ei
--   WHERE (ei.workflow_id IS NOT NULL OR EXISTS (
--           SELECT 1 FROM workflows w WHERE w.entity_type_id = ei.entity_type_id
--             AND w.is_active AND (w.tenant_id = ei.tenant_id OR w.tenant_id IS NULL)))
--     AND (coalesce(btrim(ei.fields ->> 'title'), '') = '' OR ei.due_date IS NULL
--          OR coalesce(btrim(ei.remark), '') = '' OR ei.severity IS NULL);
--
-- DOWN MIGRATION:
--   Not reversible: which values were filled in is not recorded. The defaults are recognisable
--   ('Untitled ticket #...', the 'Backfilled: ...' remark) if a record needs a closer look.

UPDATE entity_instances ei
SET fields = CASE
      WHEN coalesce(btrim(ei.fields ->> 'title'), '') = ''
        THEN jsonb_set(ei.fields, '{title}', to_jsonb('Untitled ticket #' || left(ei.id::text, 8)))
      ELSE ei.fields
    END,
    due_date = coalesce(ei.due_date, ei.created_at + interval '7 days'),
    remark = CASE
      WHEN coalesce(btrim(ei.remark), '') = ''
        THEN 'Backfilled: no remark was recorded when this ticket was created.'
      ELSE ei.remark
    END,
    severity = coalesce(ei.severity, 'medium')
WHERE (
    ei.workflow_id IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM workflows w
      WHERE w.entity_type_id = ei.entity_type_id
        AND w.is_active
        AND (w.tenant_id = ei.tenant_id OR w.tenant_id IS NULL)
    )
  )
  AND (
    coalesce(btrim(ei.fields ->> 'title'), '') = ''
    OR ei.due_date IS NULL
    OR coalesce(btrim(ei.remark), '') = ''
    OR ei.severity IS NULL
  );
