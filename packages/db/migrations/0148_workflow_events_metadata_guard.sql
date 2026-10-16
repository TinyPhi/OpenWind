-- analytics: excluded (trigger function only -- no new table)
--
-- Follow-up to 0147. app_user may still UPDATE workflow_events.metadata, and the retention sweep and
-- the history shown on a case read metadata.type and the other keys written when an event is
-- created. This trigger limits what any UPDATE can change in metadata to the keys the application
-- and per-user erasure legitimately edit:
--   fileIds, mentions, mentionIdentifiers   comment attachments and resolved mentions
--   text                                    comment text (erasure rewrites it)
--   actingPersonId, actorName               erasure: only to the redaction marker
--   changed                                 erasure: only the old/new values, only to the marker
-- Every other key, including type, is fixed once the event is written, and no other key can be added.
-- The listed keys themselves can still be added, removed or set to any value, because comments,
-- attachments and erasure need that; only actorName, actingPersonId and changed are held to the
-- redaction rules above. Must match REDACTED in apps/api/src/services/user-erasure.ts and the marker
-- used in 0147.
--
-- DOWN MIGRATION:
--   DROP TRIGGER IF EXISTS workflow_events_metadata_guard ON workflow_events;
--   DROP FUNCTION IF EXISTS workflow_events_metadata_guard();

CREATE OR REPLACE FUNCTION workflow_events_metadata_guard() RETURNS trigger AS $$
DECLARE
  editable text[] := ARRAY['fileIds', 'mentions', 'mentionIdentifiers', 'text',
                           'actorName', 'actingPersonId', 'changed'];
  redacted jsonb := to_jsonb('[REDACTED]'::text);
BEGIN
  IF NEW.metadata IS NOT DISTINCT FROM OLD.metadata THEN
    RETURN NEW;
  END IF;
  IF jsonb_typeof(OLD.metadata) IS DISTINCT FROM 'object'
     OR jsonb_typeof(NEW.metadata) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'workflow_events.metadata must stay an object' USING ERRCODE = '42501';
  END IF;
  IF (OLD.metadata - editable) IS DISTINCT FROM (NEW.metadata - editable) THEN
    RAISE EXCEPTION 'workflow_events.metadata: only fileIds, mentions, mentionIdentifiers, text, actorName, actingPersonId and changed may be edited'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.metadata -> 'actingPersonId' IS DISTINCT FROM OLD.metadata -> 'actingPersonId'
     AND (NEW.metadata -> 'actingPersonId' IS DISTINCT FROM redacted
          OR OLD.metadata -> 'actingPersonId' IS NULL) THEN
    RAISE EXCEPTION 'workflow_events.metadata.actingPersonId may only be redacted' USING ERRCODE = '42501';
  END IF;
  IF NEW.metadata -> 'actorName' IS DISTINCT FROM OLD.metadata -> 'actorName'
     AND (NEW.metadata -> 'actorName' IS DISTINCT FROM redacted
          OR OLD.metadata -> 'actorName' IS NULL) THEN
    RAISE EXCEPTION 'workflow_events.metadata.actorName may only be redacted' USING ERRCODE = '42501';
  END IF;
  IF NEW.metadata -> 'changed' IS DISTINCT FROM OLD.metadata -> 'changed' THEN
    IF jsonb_typeof(OLD.metadata -> 'changed') IS DISTINCT FROM 'object'
       OR jsonb_typeof(NEW.metadata -> 'changed') IS DISTINCT FROM 'object'
       OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(OLD.metadata -> 'changed') AS k)
          IS DISTINCT FROM
          (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(NEW.metadata -> 'changed') AS k)
       OR EXISTS (
         SELECT 1
         FROM jsonb_each(OLD.metadata -> 'changed') AS o
         JOIN jsonb_each(NEW.metadata -> 'changed') AS n USING (key)
         WHERE o.value IS DISTINCT FROM n.value
           AND NOT (
             jsonb_typeof(o.value) = 'object' AND jsonb_typeof(n.value) = 'object'
             AND (o.value - 'old' - 'new') = (n.value - 'old' - 'new')
             AND (n.value -> 'old' IS NOT DISTINCT FROM o.value -> 'old' OR n.value -> 'old' = redacted)
             AND (n.value -> 'new' IS NOT DISTINCT FROM o.value -> 'new' OR n.value -> 'new' = redacted)
           )
       ) THEN
      RAISE EXCEPTION 'workflow_events.metadata.changed may only have its old/new values redacted'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_events_metadata_guard ON workflow_events;
CREATE TRIGGER workflow_events_metadata_guard
  BEFORE UPDATE OF metadata ON workflow_events
  FOR EACH ROW EXECUTE FUNCTION workflow_events_metadata_guard();
