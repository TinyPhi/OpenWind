-- analytics: excluded (operational workflow, low analytics value)
-- down:
--   DROP TABLE IF EXISTS access_requests;

CREATE TABLE access_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  instance_id UUID NOT NULL REFERENCES entity_instances(id),
  requester_id TEXT NOT NULL,
  requested_level TEXT NOT NULL CHECK (requested_level IN ('read_only', 'read_comment', 'read_write')),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS
ALTER TABLE access_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY access_requests_tenant_isolation ON access_requests
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Indexes
CREATE INDEX access_requests_tenant_instance_idx ON access_requests (tenant_id, instance_id);
CREATE INDEX access_requests_tenant_requester_idx ON access_requests (tenant_id, requester_id);
-- One pending request per user per ticket (allow multiple if prev was resolved)
CREATE UNIQUE INDEX access_requests_one_pending_per_user
  ON access_requests (tenant_id, instance_id, requester_id)
  WHERE status = 'pending';
