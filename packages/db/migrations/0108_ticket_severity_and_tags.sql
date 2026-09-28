-- analytics: excluded (severity col: low-cardinality dimension, not yet an analytics
-- target; entity_instance_tags: free-text, excluded per audit/files pattern for
-- unstructured user content)
--
-- docs/specs/ticket-severity-and-tags.md, Phase 1 (T1/T2/T3). Adds a nullable severity
-- column to entity_instances (R1/R2/R7) and a new entity_instance_tags join table
-- (R4/R5/R7).
--
-- severity is deliberately NOT given a DB-level DEFAULT: Postgres 11+ ADD COLUMN with a
-- non-volatile DEFAULT backfills every existing row to that value at read time (no table
-- rewrite, but existing rows would stop being NULL) -- that would silently violate the
-- spec's §V invariant that NULL means "created before this feature shipped" and every
-- other row has a real value. Medium-default-on-create is enforced at the application
-- layer (Phase 2, T6/T7), not here.
--
-- entity_instance_tags' composite unique index on (tenant_id, entity_instance_id,
-- tag_text) is the DB-level enforcement backing the spec's per-ticket exact-duplicate
-- rejection and creator-lock removal semantics (§V: "not just an application-level
-- pre-check"). The write path (packages/entity-engine/src/severity-and-tags.ts)
-- normalizes tag_text (trim+lowercase) before insert, but that alone is only an
-- app-layer contract -- a second CHECK constraint below enforces the same
-- normalization in the database itself, so the uniqueness guarantee holds even
-- against a write path that doesn't go through TagTextSchema.
--
-- entity_instance_id has ON DELETE CASCADE (unlike ticket_alerts' identical FK
-- shape in migration 0045, which lacks it and silently breaks
-- apps/worker/src/tenant-purge.ts's GDPR purge for any tenant with alerts --
-- caught in this feature's own review, not re-introduced here; ticket_alerts'
-- pre-existing gap is out of scope for this migration).
--
-- Rollback (undoes only what THIS migration added):
--   REVOKE SELECT, INSERT, DELETE ON entity_instance_tags FROM app_user;
--   DROP TABLE IF EXISTS entity_instance_tags;
--   ALTER TABLE entity_instances DROP CONSTRAINT entity_instances_severity_check;
--   ALTER TABLE entity_instances DROP COLUMN severity;

ALTER TABLE entity_instances
  ADD COLUMN severity TEXT;

ALTER TABLE entity_instances
  ADD CONSTRAINT entity_instances_severity_check
    CHECK (severity IN ('low', 'medium', 'high', 'critical') OR severity IS NULL);

CREATE TABLE entity_instance_tags (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  entity_instance_id UUID NOT NULL REFERENCES entity_instances(id) ON DELETE CASCADE,
  tag_text          TEXT NOT NULL CHECK (
                      tag_text <> ''
                      AND length(tag_text) <= 50
                      AND tag_text = lower(btrim(tag_text))
                    ),
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Composite uniqueness backing the per-ticket exact-duplicate rejection (§V) --
-- normalization (trim+lowercase) happens at the write path before insert.
CREATE UNIQUE INDEX entity_instance_tags_tenant_instance_text_uidx
  ON entity_instance_tags (tenant_id, entity_instance_id, tag_text);

ALTER TABLE entity_instance_tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY entity_instance_tags_tenant_isolation ON entity_instance_tags
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE INDEX entity_instance_tags_tenant_instance_idx
  ON entity_instance_tags (tenant_id, entity_instance_id);
CREATE INDEX entity_instance_tags_tenant_text_idx
  ON entity_instance_tags (tenant_id, tag_text);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'GRANT SELECT, INSERT, DELETE ON entity_instance_tags TO app_user';
  END IF;
END
$$;
