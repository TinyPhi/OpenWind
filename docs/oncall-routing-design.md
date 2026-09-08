# On-Call Routing & Severity-Based Notification Dispatch — Design Reference

> Behavioral specification for implementation. Read alongside `docs/specs/oncall-routing.md`
> (requirements) and `docs/specs/adr-016-draft-oncall-routing.md` (decisions). This doc covers
> data shapes, API contracts, algorithm details, and sequence flows.

---

## 1. Data Model

### 1.1 `teams`

```sql
CREATE TABLE teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,

  -- analytics: included(id, tenant_id, name, created_at, deleted_at)
);

-- Partial unique index so soft-deleted names can be reused
CREATE UNIQUE INDEX teams_name_tenant_unique ON teams (tenant_id, name) WHERE deleted_at IS NULL;
CREATE INDEX teams_tenant_idx ON teams (tenant_id) WHERE deleted_at IS NULL;

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY teams_tenant_read ON teams FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY teams_tenant_write ON teams FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

### 1.2 `services`

```sql
CREATE TABLE services (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  team_id     uuid REFERENCES teams(id) ON DELETE RESTRICT,  -- nullable: service without owning team
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,

  -- analytics: included(id, tenant_id, team_id, name, created_at, deleted_at)
);

-- Partial unique index so soft-deleted names can be reused
CREATE UNIQUE INDEX services_name_tenant_unique ON services (tenant_id, name) WHERE deleted_at IS NULL;
CREATE INDEX services_tenant_idx ON services (tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX services_team_idx   ON services (team_id)   WHERE deleted_at IS NULL;

ALTER TABLE services ENABLE ROW LEVEL SECURITY;
CREATE POLICY services_tenant_read ON services FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY services_tenant_write ON services FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

### 1.3 `labels`

```sql
CREATE TABLE labels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name        text NOT NULL,
  color       text NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,

  -- analytics: included(id, tenant_id, name, created_at, deleted_at)
);

-- Partial unique index so soft-deleted names can be reused
CREATE UNIQUE INDEX labels_name_tenant_unique ON labels (tenant_id, name) WHERE deleted_at IS NULL;
CREATE INDEX labels_tenant_idx ON labels (tenant_id) WHERE deleted_at IS NULL;

ALTER TABLE labels ENABLE ROW LEVEL SECURITY;
CREATE POLICY labels_tenant_read ON labels FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY labels_tenant_write ON labels FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

### 1.4 `ticket_labels`

```sql
CREATE TABLE ticket_labels (
  -- ON DELETE RESTRICT guards against accidental hard deletes outside the soft-delete lifecycle.
  -- Note on tenant purge (apps/worker/src/tenant-purge.ts): ticket_labels rows must be purged
  -- prior to entity_instances rows to satisfy the RESTRICT constraint.
  ticket_instance_id uuid NOT NULL REFERENCES entity_instances(id) ON DELETE RESTRICT,
  label_id           uuid NOT NULL REFERENCES labels(id) ON DELETE RESTRICT,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  assigned_by        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_at        timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (ticket_instance_id, label_id)
  -- analytics: included(ticket_instance_id, label_id, tenant_id, assigned_by, assigned_at)
);

CREATE INDEX ticket_labels_ticket_idx ON ticket_labels (ticket_instance_id);
CREATE INDEX ticket_labels_label_idx  ON ticket_labels (label_id);
CREATE INDEX ticket_labels_tenant_idx ON ticket_labels (tenant_id);

ALTER TABLE ticket_labels ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_labels_tenant_read ON ticket_labels FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY ticket_labels_tenant_write ON ticket_labels FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

### 1.5 `on_call_schedules`

```sql
-- Requires btree_gist extension — migration 0092 includes
-- CREATE EXTENSION IF NOT EXISTS btree_gist before this table DDL.
CREATE TABLE on_call_schedules (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  team_id                     uuid NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  label                       text NOT NULL,
  starts_at                   timestamptz NOT NULL,
  ends_at                     timestamptz NOT NULL,
  primary_user_id             uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  backup_user_id              uuid REFERENCES users(id) ON DELETE RESTRICT,            -- nullable
  escalation_manager_user_id  uuid REFERENCES users(id) ON DELETE RESTRICT,            -- nullable
  created_by                  uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  deleted_at                  timestamptz,   -- soft-delete; preserves audit trail history

  CONSTRAINT schedule_window_valid CHECK (ends_at > starts_at),

  -- DB-level overlap prevention: no two entries for the same (tenant, team) can have
  -- overlapping time windows. Requires btree_gist.
  EXCLUDE USING gist (
    tenant_id WITH =,
    team_id   WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (deleted_at IS NULL)
  -- analytics: included(id, tenant_id, team_id, starts_at, ends_at, created_at, deleted_at)
);

CREATE INDEX on_call_schedules_team_time_idx
  ON on_call_schedules (tenant_id, team_id, starts_at, ends_at) WHERE deleted_at IS NULL;

ALTER TABLE on_call_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY on_call_schedules_tenant_read ON on_call_schedules FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY on_call_schedules_tenant_write ON on_call_schedules FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

### 1.6 `notification_policies`

```sql
CREATE TABLE notification_policies (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  -- scope dimensions (all nullable; null = "any")
  team_id                   uuid REFERENCES teams(id) ON DELETE RESTRICT,
  -- workflow_type_id references workflows(id) but no FK constraint is declared here:
  -- workflows is tenant-scoped and FK checks bypass RLS, so referential integrity is
  -- enforced at the app layer (POST/PATCH must validate workflow_type_id belongs to
  -- the same tenant) — same pattern as services.team_id and ticket_labels.label_id.
  workflow_type_id          uuid,
  severity                  text NOT NULL
                            CHECK (severity IN ('critical','high','medium','low')),
  channels                  text[] NOT NULL,   -- non-empty subset of known channel names
  notify_backup             boolean NOT NULL DEFAULT true,
  notify_escalation_manager boolean NOT NULL DEFAULT false,
  created_by                uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  deleted_at                timestamptz,   -- soft-delete; preserves audit trail history

  CONSTRAINT channels_not_empty CHECK (cardinality(channels) > 0)
  -- analytics: included(id, tenant_id, team_id, severity, channels, created_at, deleted_at)
);

-- Uniqueness at each specificity level enforced via four partial indexes
-- (composite UNIQUE fails for nullable columns in Postgres: NULL != NULL)
-- All indexes are predicated on deleted_at IS NULL so soft-deleted policies
-- free their uniqueness slot for a replacement.
CREATE UNIQUE INDEX notif_policy_global_severity
  ON notification_policies (tenant_id, severity)
  WHERE team_id IS NULL AND workflow_type_id IS NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX notif_policy_team_severity
  ON notification_policies (tenant_id, team_id, severity)
  WHERE team_id IS NOT NULL AND workflow_type_id IS NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX notif_policy_workflow_severity
  ON notification_policies (tenant_id, workflow_type_id, severity)
  WHERE team_id IS NULL AND workflow_type_id IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX notif_policy_team_workflow_severity
  ON notification_policies (tenant_id, team_id, workflow_type_id, severity)
  WHERE team_id IS NOT NULL AND workflow_type_id IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE notification_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_policies_tenant_read ON notification_policies FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY notification_policies_tenant_write ON notification_policies FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

### 1.7 Ticket entity type — new system fields (seed SQL)

Added via `modules/helpdesk/seed.sql` (and mirrored in any other ticket-bearing module):

```sql
-- severity
INSERT INTO entity_fields (entity_type_id, name, field_type, is_system, options, "order")
SELECT id, 'severity', 'select', true,
  '{"choices":["critical","high","medium","low"]}',
  (SELECT COALESCE(MAX("order"),0)+10 FROM entity_fields WHERE entity_type_id = et.id)
FROM entity_types et WHERE et.slug = 'ticket' AND et.tenant_id IS NULL;

-- team_id
INSERT INTO entity_fields (entity_type_id, name, field_type, is_system, ref_table, "order")
SELECT id, 'team_id', 'entity_ref', true, 'teams',
  (SELECT COALESCE(MAX("order"),0)+20 FROM entity_fields WHERE entity_type_id = et.id)
FROM entity_types et WHERE et.slug = 'ticket' AND et.tenant_id IS NULL;

-- service_id
INSERT INTO entity_fields (entity_type_id, name, field_type, is_system, ref_table, "order")
SELECT id, 'service_id', 'entity_ref', true, 'services',
  (SELECT COALESCE(MAX("order"),0)+30 FROM entity_fields WHERE entity_type_id = et.id)
FROM entity_types et WHERE et.slug = 'ticket' AND et.tenant_id IS NULL;

-- Note: labels are NOT entity-engine fields. They are managed via the `labels` table and
-- assigned through the `ticket_labels` junction table. See sections 1.3, 1.4, and 2.x.
```

### 1.8 `admin_audit_log` new action strings

Added to the DB CHECK constraint (migration):

```sql
-- oncall routing
'oncall.auto_assigned', 'oncall.no_schedule', 'oncall.skipped_explicit_assignee',
-- severity notifications
'notification.dispatched', 'notification.channel_failed',
-- label assignment
'label.assigned', 'label.removed'
```

---

## 2. API Reference

All routes are under `apps/api/src/routes/admin/`. Auth: `requireAuth()` + `requireRole("admin")`
for writes; agents get `requireRole("admin","agent")` on GET routes used for dropdown population.

### 2.1 Teams

#### `GET /admin/teams`

Query params: `cursor?: uuid`, `limit?: number (1–100, default 20)`, `includeDeleted?: boolean`

Response `200`:

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "string",
      "description": "string|null",
      "createdAt": "ISO8601"
    }
  ],
  "nextCursor": "uuid|null"
}
```

#### `POST /admin/teams`

Body:

```json
{ "name": "string (1–100)", "description": "string|null" }
```

Response `201`: `{ "data": { ...team } }`
Errors: `409` duplicate name in tenant.

#### `PATCH /admin/teams/:id`

Body: same fields, all optional. Response `200`: `{ "data": { ...team } }`
Errors: `404` not found; `409` name collision.

#### `DELETE /admin/teams/:id`

Soft-deletes. Returns `204`. Errors: `400` if team has active services (must soft-delete or
reassign services first); `404` not found.

### 2.2 Services

Same CRUD shape as teams, with one additional field:

```json
{ "name": "string", "description": "string|null", "teamId": "uuid|null" }
```

`GET /admin/services` response includes `{ "teamName": "string|null" }` resolved inline.

### 2.3 On-Call Schedules

#### `GET /admin/on-call-schedules`

Query params: `teamId?: uuid`, `from?: ISO8601`, `to?: ISO8601`, `cursor?: uuid`, `limit?: number`

Response `200`:

```json
{
  "data": [
    {
      "id": "uuid",
      "teamId": "uuid",
      "teamName": "string",
      "label": "string",
      "startsAt": "ISO8601",
      "endsAt": "ISO8601",
      "primaryUser": { "id": "uuid", "name": "string", "email": "string" },
      "backupUser": { "id": "uuid", "name": "string", "email": "string" } | null,
      "escalationManager": { "id": "uuid", "name": "string", "email": "string" } | null,
      "createdAt": "ISO8601"
    }
  ],
  "nextCursor": "uuid|null"
}
```

#### `POST /admin/on-call-schedules`

Body:

```json
{
  "teamId": "uuid",
  "label": "string (1–100)",
  "startsAt": "ISO8601",
  "endsAt": "ISO8601",
  "primaryUserId": "uuid",
  "backupUserId": "uuid|null",
  "escalationManagerUserId": "uuid|null"
}
```

Response `201`. Errors: `409` overlap; `422` invalid window or foreign user.

#### `GET /admin/on-call-schedules/current`

No query params. Returns every team in the tenant with its active schedule entry if one exists (LEFT JOIN — teams with no active schedule appear with `oncall: null`, not omitted). This is how the coverage-gap badge data is served.

Response `200`:

```json
{
  "data": [
    {
      "teamId": "uuid",
      "teamName": "string",
      "oncall": {
        "scheduleId": "uuid",
        "label": "string",
        "startsAt": "ISO8601",
        "endsAt": "ISO8601",
        "primaryUser": { "id": "uuid", "name": "string" },
        "backupUser": { ... } | null,
        "escalationManager": { ... } | null
      } | null
    }
  ]
}
```

### 2.4 Notification Policies

#### `GET /admin/notification-policies`

Query params: `teamId?: uuid`, `workflowTypeId?: uuid`, `severity?: critical|high|medium|low`

Response `200`:

```json
{
  "data": [
    {
      "id": "uuid",
      "teamId": "uuid|null",
      "teamName": "string|null",
      "workflowTypeId": "uuid|null",
      "workflowTypeName": "string|null",
      "severity": "critical|high|medium|low",
      "channels": ["email", "sms", "whatsapp", "call"],
      "notifyBackup": true,
      "notifyEscalationManager": false,
      "specificity": 2
    }
  ]
}
```

#### `POST /admin/notification-policies`

Body:

```json
{
  "teamId": "uuid|null",
  "workflowTypeId": "uuid|null",
  "severity": "critical|high|medium|low",
  "channels": ["email", "sms"],
  "notifyBackup": true,
  "notifyEscalationManager": false
}
```

Response `201`. Errors: `409` specificity slot already taken; `422` empty channels or unknown channel name.

#### `GET /admin/notification-policies/resolve`

Dry-run — no side effects, no audit entry.

Query params: `severity: required`, `teamId?: uuid`, `workflowTypeId?: uuid`

Response `200`:

```json
{
  "policyId": "uuid|null",
  "matchedAt": "team+workflow|team|workflow|global|hardcoded-default",
  "channels": ["email", "sms"],
  "recipients": [
    {
      "role": "assignee|backup|escalationManager",
      "userId": "uuid",
      "name": "string"
    }
  ]
}
```

### 2.5 Labels

#### `GET /admin/labels`

Query params: `cursor?: uuid`, `limit?: number (1–100, default 20)`, `includeDeleted?: boolean`

Response `200`:

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "string",
      "color": "#e11d48",
      "description": "string|null",
      "createdAt": "ISO8601"
    }
  ],
  "nextCursor": "uuid|null"
}
```

#### `POST /admin/labels`

Body:

```json
{ "name": "string (1–80)", "color": "#rrggbb", "description": "string|null" }
```

Response `201`: `{ "data": { ...label } }`
Errors: `409` duplicate name; `422` invalid hex color format.

Roles: `admin` write, `agent` GET read-only (needed for ticket form label picker).

#### `PATCH /admin/labels/:id`

Body: same fields, all optional. Response `200`: `{ "data": { ...label } }`

#### `DELETE /admin/labels/:id`

Soft-delete — `deleted_at` set; existing `ticket_labels` rows are kept for history.
Response `204`. Errors: `404` not found.

**Rate Limiting (ADR-013)**:

- Interactive admin/agent traffic: Gated by per-tenant aggregate rate limit (`RATE_LIMIT_TENANT_PER_MIN` = 600 req/min).
- Third-party API key traffic (`scopes_format = 'action'`):
  - Tier 1 (Per-Key-and-Person): 20 req/min (`RATE_LIMIT_API_KEY_PERSON_PER_MIN`)
  - Tier 2 (Per-Key Aggregate): 200 req/min (`RATE_LIMIT_API_KEY_PER_MIN`)
  - Tier 3 (Per-Tenant Aggregate): 600 req/min (`RATE_LIMIT_TENANT_PER_MIN`)
- Pre-auth IP flood limit: 500 req/min per IP (`rateLimit()` middleware).

### 2.6 Ticket Label Assignment

#### `GET /tickets/:id/labels`

Response `200`:

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "string",
      "color": "#e11d48",
      "assignedBy": "uuid",
      "assignedAt": "ISO8601"
    }
  ]
}
```

#### `PUT /tickets/:id/labels`

Atomically replaces the ticket's full label set.

Body: `{ "labelIds": ["uuid", ...] }` — empty array removes all labels.

Response `200`: `{ "data": [ ...labels ] }` (full set after replace)
Errors: `422` if any labelId belongs to a different tenant.

#### `POST /tickets/:id/labels/:labelId`

Adds one label. Idempotent — adding an already-applied label returns `200` without duplicating.
Response `200`: `{ "data": { ...label } }`
Errors: `404` label not found in tenant; `422` cross-tenant label.

Writes audit entry: `label.assigned { labelId, labelName, ticketId, actorId }`.

#### `DELETE /tickets/:id/labels/:labelId`

Removes one label.
Response `204`. Errors: `404` label not on this ticket.

Writes audit entry: `label.removed { labelId, labelName, ticketId, actorId }`.

**Rate Limiting (ADR-013)**:
All ticket label endpoints (`GET /tickets/:id/labels`, `PUT /tickets/:id/labels`, `POST /tickets/:id/labels/:labelId`, `DELETE /tickets/:id/labels/:labelId`) are agent-accessible and annotated under ADR-013's 3-tier rate limiting model:

- Interactive agent/user traffic: Gated by per-tenant aggregate rate limit (`RATE_LIMIT_TENANT_PER_MIN` = 600 req/min).
- Third-party API traffic (`scopes_format = 'action'`):
  - Tier 1 (Per-Key-and-Person): 20 req/min (`RATE_LIMIT_API_KEY_PERSON_PER_MIN`, checked via `enforceKeyPersonRateLimit`).
  - Tier 2 (Per-Key Aggregate): 200 req/min (`RATE_LIMIT_API_KEY_PER_MIN`, checked via `enforceApiKeyRateLimit`).
  - Tier 3 (Per-Tenant Aggregate): 600 req/min (`RATE_LIMIT_TENANT_PER_MIN`, checked via `enforceTenantRateLimit`).
- Pre-auth flood limit: 500 req/min per client IP (`rateLimit()` middleware).

### 2.7 Ticket list label filter (extension to existing `GET /tickets`)

R1c requires that tickets can be filtered by label. This is implemented as an additional
query param on the existing ticket listing endpoint (not a new route):

```
GET /tickets?label_id=<uuid>
```

Returns only tickets that have the given label assigned, within the same tenant. The label
must belong to the same tenant — a label_id from another tenant returns an empty result (not
a 404, to avoid tenant existence disclosure). Accessible to `agent` role.

---

## 3. Automation Actions

### 3.1 `resolve_oncall`

**Trigger condition** (system-seeded automation rule):

- Event: `entity.updated`
- Condition: `fields.team_id IS NOT NULL AND fields.team_id != prev_fields.team_id`
  (or `entity.created` with `fields.team_id IS NOT NULL`)

**Explicit-assignee-wins guard:**
If the triggering event payload includes both `team_id` and `assignee` as changed fields, skip
resolution and write `oncall.skipped_explicit_assignee`. Applied before the schedule lookup.

**Algorithm:**

```
1. Extract team_id from triggering entity's current field values.
2. Query:
     SELECT * FROM on_call_schedules
     WHERE tenant_id = :tenantId
       AND team_id   = :teamId
       AND starts_at <= now()
       AND ends_at   > now()
     LIMIT 1
3. If no row: write audit(oncall.no_schedule); return.
4. Call updateEntity(ticketId, { assignee: schedule.primary_user_id })
   inside the same transaction as the audit write.
5. Write audit(oncall.auto_assigned, {
     teamId, scheduleId, primaryUserId, backupUserId
   }).
6. If schedule.backup_user_id:
     enqueue notification to backup_user_id via @platform/notifications.
```

**Idempotency key:** `oncall_resolve:{ticketId}:{team_id_value}` — if already processed for
this (ticket, team_id) pair, skip and return.

**Accepted TOCTOU trade-off:** the schedule lookup in step 2 is a plain SELECT without `FOR
UPDATE`. Between the lookup and the `updateEntity` call in step 4, the schedule entry may be
deleted or rotated. This window is accepted: schedule changes are infrequent admin operations,
and the lookup-to-assign latency is sub-100ms. The assignee set by `resolve_oncall` reflects
the primary on-call at lookup time, not guaranteed-current at commit time. If stronger
guarantees are needed in future, add a `SELECT ... FOR UPDATE` inside the write transaction.

### 3.2 `dispatch_severity_notification`

**Trigger condition** (system-seeded automation rule):

- Event: `entity.updated`
- Condition: `fields.severity IS NOT NULL AND fields.severity != prev_fields.severity`
  (or `entity.created` with `fields.severity IS NOT NULL`)

**Policy resolution algorithm:**

```
Given (tenantId, teamId, workflowTypeId, severity):

score(policy):
  s = 0
  if policy.team_id          IS NOT NULL → s += 2
  if policy.workflow_type_id IS NOT NULL → s += 1
  return s

candidates = SELECT * FROM notification_policies
             WHERE tenant_id = :tenantId
               AND severity  = :severity
               AND (team_id IS NULL          OR team_id          = :teamId)
               AND (workflow_type_id IS NULL OR workflow_type_id = :workflowTypeId)

policy = candidate with highest score(policy)
       ?? { channels: ['email'], notifyBackup: true, notifyEscalationManager: false }
```

**Recipient resolution:**

```
recipients = [ticket.assignee]

if policy.notifyBackup AND current_oncall_schedule.backup_user_id:
  recipients += backup_user_id

if (policy.notifyEscalationManager OR severity == 'critical')
   AND current_oncall_schedule.escalation_manager_user_id:
  recipients += escalation_manager_user_id
```

**Channel dispatch (independent per channel):**

`@platform/notifications.sendNotification` **enqueues a BullMQ job** and returns — it does not
deliver synchronously. It throws only on enqueue-time failures (Redis unavailable, bad template
ID). Actual delivery failures happen asynchronously inside `notification-outbound-worker.ts`
under ADR-014's 3-attempt retry/exhaustion policy, which emits its own `notification.delivery_failed`
audit event and system note. `dispatch_severity_notification` does not own delivery semantics.

```
for channel in policy.channels:
  try:
    // sendNotification enqueues a BullMQ delivery job — does NOT deliver inline.
    // Throws only on enqueue failure (Redis down, unknown templateId).
    sendNotification({
      channel,
      recipients,
      subject: buildSubject(ticket, severity),
      payload: buildPayload(ticket),
    })
    // no per-channel audit write on enqueue success — covered by dispatched entry below
  catch:
    // Enqueue-time failure only (Redis, bad template). Provider errors that contain
    // PII (phone numbers, email addresses) never reach here — those surface at delivery
    // time in the notification-outbound-worker under ADR-014's pipeline.
    sanitized = sanitizeProviderError(err)   // masks E.164 numbers, truncates to 200 chars
    writeAuditEntry({ action: 'notification.channel_failed',
                      metadata: { channel, errorCode: sanitized.code, errorSummary: sanitized.message } })
    logger.warn({ channel, ticketId, errorCode: sanitized.code }, 'notification channel enqueue failed')
    // continue — do not abort remaining channels

writeAuditEntry({ action: 'notification.dispatched',
                  metadata: { channels, recipientCount, policyId, matchedAt } })
// Note: 'notification.dispatched' records enqueue completion, not delivery confirmation.
// Delivery confirmation / failure is tracked by ADR-014's worker via 'notification.delivery_failed'.
```

**Two-level failure model:**

| Event                          | Who writes it                          | When                                     |
| ------------------------------ | -------------------------------------- | ---------------------------------------- |
| `notification.channel_failed`  | `dispatch_severity_notification`       | Enqueue fails (Redis down, bad template) |
| `notification.delivery_failed` | ADR-014 `notification-outbound-worker` | Delivery exhausted after 3 attempts      |

**Idempotency key:** `severity_notify:{ticketId}:{severity_value}` — prevents duplicate
dispatch if the same `entity.updated` event is re-delivered.

---

## 4. Security Model

| Concern                                                               | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-tenant team data                                                | RLS read/write policy pairs (nullif-guarded) on all 6 new tables; all queries inside `withTenantContext`                                                                                                                                                                                                                                                                                                                                                            |
| Cross-tenant user references in schedules                             | At write time, `primary_user_id`/`backup_user_id`/`escalation_manager_user_id` are validated against the tenant's user list before insert; DB FKs to `users` provide referential integrity                                                                                                                                                                                                                                                                          |
| Cross-tenant FK bypass (`services.team_id`, `ticket_labels.label_id`) | PostgreSQL FK checks run as table owner and bypass RLS. The `POST/PATCH /admin/services` route **must** validate that the provided `teamId` belongs to the same tenant as the service before executing the write (application-layer ownership check). The `POST /tickets/:id/labels/:labelId` route must perform the same check for `labelId`. This is the platform's canonical pattern for cross-table FKs between tenant-scoped tables — see `db-conventions.md`. |
| Cross-tenant `entity_ref` on tickets                                  | Entity engine's built-in cross-tenant reference guard (`CROSS_TENANT_REFERENCE` error code) covers `team_id` and `service_id`                                                                                                                                                                                                                                                                                                                                       |
| Schedule overlap correctness                                          | GIST exclusion constraint (with `WHERE deleted_at IS NULL`) — not application-layer-only                                                                                                                                                                                                                                                                                                                                                                            |
| Notification policy write access                                      | `requireRole("admin")` on all POST/PATCH/DELETE policy routes                                                                                                                                                                                                                                                                                                                                                                                                       |
| Notification policy slot collision                                    | Partial unique indexes per specificity level; application-layer check returns `409` before hitting the DB constraint for a clean error                                                                                                                                                                                                                                                                                                                              |
| Provider error PII in audit log                                       | Twilio/Novu/WhatsApp error messages may include phone numbers, email addresses, or provider user IDs. The `notification.channel_failed` audit entry must strip the raw `err.message` and log only a sanitized form: error code + truncated provider message with E.164 numbers masked. Same sanitization applies to `logger.warn` calls.                                                                                                                            |
| Resolve endpoint user name disclosure                                 | `GET /admin/notification-policies/resolve` returns the names and user IDs of the current on-call person and escalation manager. This is intentional: on-call information is not confidential within a tenant and agents need it to understand routing. The endpoint is rate-limited per ADR-013's per-key tier.                                                                                                                                                     |
| Label assignment rate limiting                                        | `POST /tickets/:id/labels/:labelId` and `PUT /tickets/:id/labels` are agent-accessible and could be abused to flood the `ticket_labels` table at scale. Both endpoints must apply ADR-013's per-key-and-person tier. Write routes on `/admin/labels`, `/admin/on-call-schedules`, and `/admin/notification-policies` apply ADR-013's per-key tier (admin-only, lower abuse risk).                                                                                   |
| Audit trail                                                           | Every routing and notification event (success or failure) written to `admin_audit_log` in the same DB transaction as the triggering mutation                                                                                                                                                                                                                                                                                                                        |

---

## 5. Sequence Diagrams

### 5.1 Ticket assigned to team → on-call auto-assignment

```
Agent (HTTP)          API route          Automation engine     DB
    |                     |                    |                |
    | PATCH /tickets/:id  |                    |                |
    | { team_id: X }      |                    |                |
    |-------------------->|                    |                |
    |                     | updateEntity()     |                |
    |                     |-------------------------------------->|
    |                     |                    |  entity.updated |
    |                     |<-- 200 OK ---------|                |
    |<-- 200 OK           |                    |                |
    |                     |                    |                |
    :  (async, BullMQ)    :                    :                :
    |                     |          outbox poller picks up event
    |                     |                    |                |
    |                     |         executeAutomationRules()    |
    |                     |                    |                |
    |                     |    resolve_oncall action            |
    |                     |                    |                |
    |                     |                    | SELECT from    |
    |                     |                    | on_call_schedules
    |                     |                    |--------------->|
    |                     |                    |<- schedule row |
    |                     |                    |                |
    |                     |                    | updateEntity   |
    |                     |                    | (assignee=P)   |
    |                     |                    |--------------->|
    |                     |                    | writeAudit     |
    |                     |                    | (auto_assigned)|
    |                     |                    |--------------->|
    |                     |                    |                |
    |                     |                    | notify(backup) |
    |                     |                    |-- Novu ------->|
```

### 5.2 Severity set → notification dispatch

```
Agent (HTTP)         API route       Automation engine    Notification policies    Novu
    |                    |                 |                      |                  |
    | PATCH /tickets/:id |                 |                      |                  |
    | { severity: high } |                 |                      |                  |
    |------------------->|                 |                      |                  |
    |                    | updateEntity()  |                      |                  |
    |<-- 200 OK          |                 |                      |                  |
    :   (async)          :                 :                      :                  :
    |                    |     outbox poller → dispatch_severity_notification        |
    |                    |                 |                      |                  |
    |                    |                 | SELECT notification_ |                  |
    |                    |                 | policies (scored)    |                  |
    |                    |                 |--------------------->|                  |
    |                    |                 |<- policy: [email,sms]|                  |
    |                    |                 |                      |                  |
    |                    |                 | resolve recipients   |                  |
    |                    |                 | (assignee+backup)    |                  |
    |                    |                 |                      |                  |
    |                    |                 | send(email) -------> Novu (email)       |
    |                    |                 | send(sms)   -------> Novu (SMS/Twilio) |
    |                    |                 |                      |                  |
    |                    |                 | writeAudit(dispatched)                  |
```

---

## 6. Environment Variables (new)

| Variable                    | Required for     | Notes                                          |
| --------------------------- | ---------------- | ---------------------------------------------- |
| `NOVU_SMS_PROVIDER_ID`      | SMS channel      | Novu provider integration ID (Twilio, etc.)    |
| `NOVU_WHATSAPP_PROVIDER_ID` | WhatsApp channel | Novu provider integration ID (Meta / Twilio)   |
| `NOVU_VOICE_PROVIDER_ID`    | Call channel     | Novu provider integration ID (Twilio Voice)    |
| `TWILIO_ACCOUNT_SID`        | SMS + call       | Twilio credentials if using Twilio as provider |
| `TWILIO_AUTH_TOKEN`         | SMS + call       | —                                              |
| `TWILIO_FROM_NUMBER`        | SMS + call       | Caller/sender number in E.164 format           |
| `WHATSAPP_BUSINESS_NUMBER`  | WhatsApp         | Sender number registered with Meta             |

All variables read via `@platform/config` (Zod-validated). Channels whose provider env vars are
absent at startup emit a `warn`-level log entry and are silently skipped at dispatch time (same
pattern as the existing Novu `NOVU_API_KEY` guard). See `docs/local-setup.md` for setup steps.

---

## 7. Migration Sequence

| Migration ID | What it does                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------- |
| 0090         | `teams` table + RLS + index                                                                     |
| 0091         | `services` table + RLS + index                                                                  |
| 0092         | `CREATE EXTENSION IF NOT EXISTS btree_gist` + `on_call_schedules` table + GIST exclusion + RLS  |
| 0093         | `notification_policies` table + partial unique indexes + RLS                                    |
| 0094         | Extend `admin_audit_log` CHECK constraint for `oncall.*` + `notification.*` + `label.*` strings |
| 0095         | Seed: add `severity`, `team_id`, `service_id` system fields to `ticket` entity type             |
| 0096         | `labels` table + RLS + index                                                                    |
| 0097         | `ticket_labels` junction table + RLS + indexes                                                  |

Each migration follows the standard pattern: `docs/migrations/<id>_<slug>.sql` + journal entry.
Migration 0092 includes `CREATE EXTENSION IF NOT EXISTS btree_gist;` as its first statement,
before the table and GIST-constraint DDL. (`grep -rn "CREATE EXTENSION" packages/db/migrations/`
returns no hits in the current repo — `btree_gist` is not yet enabled anywhere, so 0092 must
create it; the `IF NOT EXISTS` guard makes the statement idempotent.)

---

## 8. Test Coverage

**Coverage targets:** ≥ 90 % line coverage on all new packages and route handlers; 100 %
branch coverage on `resolveOncall()` and `dispatchSeverityNotification()` (zero untested
code paths in the two hot-path actions).

### 8.1 Unit tests

#### `resolve_oncall` action

| Scenario                                                   | Expected                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| Active schedule exists for team                            | `assignee` set to `primary_user_id`; `oncall.auto_assigned` audited  |
| No active schedule (gap)                                   | `assignee` unchanged; `oncall.no_schedule` audited                   |
| `assignee` + `team_id` both in same payload                | explicit `assignee` wins; `oncall.skipped_explicit_assignee` audited |
| Re-delivery of same event version (idempotency key hit)    | no second write, no duplicate audit row                              |
| `primary_user_id` in schedule belongs to different tenant  | rejected at write time; never reaches resolution                     |
| `backup_user_id` is null                                   | no backup notification enqueued; no error                            |
| Schedule found but `starts_at > now()` (future entry only) | treated as no active schedule                                        |
| `team_id` changed to same value (no actual change)         | action skipped; trigger condition not met                            |

#### `dispatch_severity_notification` action

| Scenario                                                                  | Expected                                                                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Policy at team+workflow level (score=3) wins over team-only (score=2)     | team+workflow policy channels dispatched                                                                                        |
| Policy at global level only                                               | global policy channels dispatched                                                                                               |
| No policy at any level                                                    | email-only (hardcoded default) dispatched                                                                                       |
| SMS enqueue fails (Redis down / bad template)                             | email still enqueued; `notification.channel_failed` audited for SMS only                                                        |
| All channel enqueues fail                                                 | `notification.channel_failed` for each; ticket mutation not rolled back; delivery failures handled separately by ADR-014 worker |
| `severity` unchanged on update (idempotency key hit)                      | no re-dispatch                                                                                                                  |
| Severity set to same value as current                                     | no re-dispatch                                                                                                                  |
| `severity = "critical"` with `notify_escalation_manager: false` on policy | escalation manager notified anyway (implicit critical rule)                                                                     |
| Provider error message contains E.164 phone number                        | audit entry stores masked form, not raw `err.message`                                                                           |

#### Notification policy specificity scorer

| Input (team_id, workflow_type_id) | Expected score                    |
| --------------------------------- | --------------------------------- |
| both set                          | 3                                 |
| team only                         | 2                                 |
| workflow only                     | 1                                 |
| neither                           | 0                                 |
| Two candidates at same score      | rejected at write time with `409` |

#### Label CRUD and assignment

| Scenario                                            | Expected                                                   |
| --------------------------------------------------- | ---------------------------------------------------------- |
| `color` not a 6-digit hex                           | `422`                                                      |
| Duplicate label name in same tenant                 | `409`                                                      |
| Duplicate name after soft-delete of original        | `201` (partial unique index allows reuse)                  |
| Assign label from different tenant                  | `422`                                                      |
| `PUT /tickets/:id/labels` with empty array          | all labels removed atomically                              |
| `POST /tickets/:id/labels/:labelId` already applied | `200`, no duplicate row                                    |
| Soft-delete a label then fetch ticket's labels      | label no longer in response; `ticket_labels` row preserved |

#### On-call schedule constraints

| Scenario                                                     | Expected                       |
| ------------------------------------------------------------ | ------------------------------ |
| Overlapping window for same (tenant, team)                   | `409` (GIST exclusion)         |
| `starts_at >= ends_at`                                       | `422`                          |
| `PATCH` on schedule where `starts_at <= now()`               | `422` (window already started) |
| Soft-delete preserves row; audit references still resolvable | `200` on audit fetch           |

---

### 8.2 Integration tests (per route group)

#### Teams + Services

- `POST /admin/teams` → `201`; `GET /admin/teams` lists it; duplicate name → `409`
- `DELETE /admin/teams/:id` → soft-delete; `GET /admin/teams` hides it; team still FK-present
- Name reuse after soft-delete: `POST /admin/teams` with same name → `201`
- Agent `POST /admin/teams` → `403`; agent `GET /admin/teams` → `200`
- `POST /admin/services` with `teamId` from different tenant → `422` (application-layer FK guard)

#### On-Call Schedules

- `POST` with overlap → `409`; `POST` with valid non-overlapping window → `201`
- `GET /admin/on-call-schedules/current` — all teams returned including uncovered (`oncall: null`)
- `PATCH` on future-window entry → `200`; `PATCH` on active/past entry → `422`
- `DELETE` → soft-delete; entry still resolvable in audit context

#### Notification Policies

- `POST` with same specificity slot twice → `409`
- `POST` with `channels: []` → `422`
- `POST` with unknown channel name → `422`
- `GET /admin/notification-policies/resolve` — correct policy at each of 4 specificity levels; hardcoded default when none exist

#### Labels

- Full CRUD; `color` validation; soft-delete; name reuse after delete
- `PUT /tickets/:id/labels` with mixed valid + cross-tenant IDs → `422` (atomic; none applied)

---

### 8.3 Isolation tests (RLS — `tests/isolation/`)

One file per new table (`teams.isolation.test.ts`, `services.isolation.test.ts`, etc.).

| Table                   | What to verify                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `teams`                 | Tenant B reads return `[]` when only Tenant A has rows; Tenant B write with Tenant A `tenant_id` in body → blocked by `WITH CHECK` |
| `services`              | Same; also: Tenant B cannot reference Tenant A's team via `teamId` FK (application check)                                          |
| `on_call_schedules`     | `resolve_oncall` only queries schedules in the triggering ticket's tenant                                                          |
| `notification_policies` | `dispatch_severity_notification` never returns policies from another tenant                                                        |
| `labels`                | Tenant B reads return `[]`; Tenant B cannot assign Tenant A's label to a ticket                                                    |
| `ticket_labels`         | `GET /tickets/:id/labels` never returns labels from another tenant's label table                                                   |

---

### 8.4 End-to-end tests (Docker stack)

- **Full routing flow:** `POST /tickets` with `team_id` set → poll for `assignee` set within 5 s; audit log contains `oncall.auto_assigned`
- **Full notification flow:** `PATCH /tickets/:id` with `severity: "critical"` → Novu test-mode event received for every channel in the matching critical policy within 10 s
- **Coverage-gap badge:** create team with no schedule → admin UI shows badge on affected tickets
- **Label filter:** apply label to 3 tickets; `GET /tickets?label_id=X` returns exactly those 3
- **Policy update takes effect immediately:** change policy channels → next severity-change event uses new channels, not cached old ones

---

## 9. Observability & Telemetry

### 9.1 Structured logging

All new log statements follow the existing pino convention — **object first, message second**.
Required fields per context:

| Context                          | Required fields                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `resolve_oncall`                 | `tenantId`, `ticketId`, `teamId`, `result` (`assigned`/`no_schedule`/`skipped`)      |
| `dispatch_severity_notification` | `tenantId`, `ticketId`, `severity`, `policyId`, `channels`, `recipientCount`         |
| `notification.channel_failed`    | `tenantId`, `ticketId`, `channel`, `errorCode` (sanitized — no raw provider message) |
| Label assignment                 | `tenantId`, `ticketId`, `labelId`, `actorId`, `action` (`assigned`/`removed`)        |
| Schedule overlap rejected        | `tenantId`, `teamId`, `conflictingScheduleId`                                        |

**Never log:** raw provider error bodies, phone numbers, email addresses, user names, ticket subject/body content.

---

### 9.2 Prometheus metrics

All new metrics are registered in `packages/telemetry/src/metrics.ts` following the existing naming convention (`openwind_*`).

#### Counters

| Metric                                     | Labels                                                              | What it counts                                  |
| ------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------- |
| `openwind_oncall_resolution_total`         | `result={assigned,no_schedule,skipped_explicit}`, `tenant_hash`     | Every `resolve_oncall` action invocation        |
| `openwind_notification_dispatch_total`     | `channel`, `result={success,failed}`, `severity`                    | Per-channel dispatch attempt                    |
| `openwind_notification_policy_match_total` | `matched_at={team_workflow,team,workflow,global,hardcoded_default}` | Where in the specificity chain the match landed |
| `openwind_label_assignment_total`          | `action={assigned,removed}`                                         | Label assignment / removal events               |

#### Histograms

| Metric                                            | Labels    | SLO                                                                      |
| ------------------------------------------------- | --------- | ------------------------------------------------------------------------ |
| `openwind_oncall_resolution_duration_seconds`     | `result`  | p99 ≤ 100 ms (enforced by integration test asserting `durationMs < 100`) |
| `openwind_notification_dispatch_duration_seconds` | `channel` | p99 ≤ 2 s per channel                                                    |

#### Gauges

| Metric                               | Labels        | What it measures                                                                                                                |
| ------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `openwind_oncall_coverage_gap_teams` | `tenant_hash` | Number of active teams in the tenant with no current on-call schedule entry; refreshed every minute by the SLA scheduler worker |

---

### 9.3 OpenTelemetry tracing

New spans created inside the two automation actions. All spans inherit the parent trace from the BullMQ job that fires them (the existing worker OTel setup propagates context through the job payload).

#### `resolve_oncall` span

```
span name:  "oncall.resolve"
kind:       INTERNAL
attributes:
  oncall.team_id        string
  oncall.ticket_id      string
  oncall.tenant_id      string (hashed — not raw UUID)
  oncall.result         string  // "assigned" | "no_schedule" | "skipped_explicit"
  oncall.schedule_id    string  // set only on "assigned"
  oncall.duration_ms    int
events:
  "schedule.lookup"   — on DB query start
  "entity.update"     — on assignee write start
```

#### `dispatch_severity_notification` span

```
span name:  "notification.dispatch_severity"
kind:       INTERNAL
attributes:
  notification.ticket_id       string
  notification.tenant_id       string (hashed)
  notification.severity        string
  notification.policy_id       string | "hardcoded_default"
  notification.matched_at      string  // specificity level
  notification.channel_count   int
  notification.recipient_count int
child spans (one per channel):
  span name:  "notification.send_channel"
  attributes: notification.channel string, notification.result string
  status:     OK on success, ERROR on failure (with sanitized error description)
```

---

### 9.4 Grafana dashboard

Add a new **On-Call Routing** row to the existing ops dashboard (`docs/sup-docs/grafana-oncall.json` — to be created by the Phase 1 implementer from the metric names above).

**Panels:**

| Panel                             | Query                                                                                                                            | Purpose                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| On-Call Resolution Rate           | `rate(openwind_oncall_resolution_total[5m])` by `result`                                                                         | Spot coverage gaps (rising `no_schedule`)                                    |
| Resolution p99 Latency            | `histogram_quantile(0.99, openwind_oncall_resolution_duration_seconds_bucket)`                                                   | SLO alert if > 100 ms                                                        |
| Notification Channel Success Rate | `rate(openwind_notification_dispatch_total{result="success"}[5m]) / rate(openwind_notification_dispatch_total[5m])` by `channel` | Detect provider degradation per channel                                      |
| Notification Dispatch Latency p99 | `histogram_quantile(0.99, openwind_notification_dispatch_duration_seconds_bucket)` by `channel`                                  | Per-channel delivery health                                                  |
| Policy Match Distribution         | `rate(openwind_notification_policy_match_total[5m])` by `matched_at`                                                             | Confirm policies are being hit (high `hardcoded_default` = misconfiguration) |
| Coverage Gaps (live)              | `openwind_oncall_coverage_gap_teams`                                                                                             | Teams currently uncovered — drives admin badge                               |

**Alert rules** (Prometheus alerting rules — add to `prometheus/alerts/oncall.yml`):

```yaml
- alert: OncallResolutionSLOBreached
  expr: histogram_quantile(0.99, rate(openwind_oncall_resolution_duration_seconds_bucket[5m])) > 0.1
  for: 2m
  labels: { severity: warning }
  annotations:
    summary: "On-call resolution p99 > 100 ms"

- alert: NotificationChannelHighFailureRate
  expr: rate(openwind_notification_dispatch_total{result="failed"}[5m])
    / rate(openwind_notification_dispatch_total[5m]) > 0.1
  for: 5m
  labels: { severity: warning }
  annotations:
    summary: "Notification channel {{ $labels.channel }} failure rate > 10 %"

- alert: OncallCoverageGapsDetected
  expr: sum(openwind_oncall_coverage_gap_teams) > 0
  for: 10m
  labels: { severity: info }
  annotations:
    summary: "{{ $value }} team(s) have no active on-call schedule"
```

---

### 9.5 New tasks (test coverage + observability)

These extend the §T task list in `docs/specs/oncall-routing.md`:

| ID  | Task                                                                                                                                    | Phase |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| T39 | Register Prometheus metrics in `packages/telemetry/src/metrics.ts` (`openwind_oncall_*`, `openwind_notification_*`, `openwind_label_*`) | 3     |
| T40 | Add OTel spans to `resolve_oncall` and `dispatch_severity_notification` with the attribute set in §9.3                                  | 3     |
| T41 | Add `openwind_oncall_coverage_gap_teams` gauge refresh to the SLA scheduler worker (1-minute cadence)                                   | 3     |
| T42 | Grafana dashboard JSON for the On-Call Routing row (6 panels from §9.4)                                                                 | 4     |
| T43 | Prometheus alert rules YAML (`oncall.yml`) with the 3 alert rules from §9.4                                                             | 4     |
