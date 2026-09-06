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
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,

  CONSTRAINT teams_name_tenant_unique UNIQUE (tenant_id, name)
  -- analytics: included(id, tenant_id, name, created_at, deleted_at)
);

CREATE INDEX teams_tenant_idx ON teams (tenant_id) WHERE deleted_at IS NULL;

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY teams_tenant_isolation ON teams
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

### 1.2 `services`

```sql
CREATE TABLE services (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  team_id     uuid REFERENCES teams(id),      -- nullable: service without owning team
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,

  CONSTRAINT services_name_tenant_unique UNIQUE (tenant_id, name)
  -- analytics: included(id, tenant_id, team_id, name, created_at, deleted_at)
);

CREATE INDEX services_tenant_idx ON services (tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX services_team_idx   ON services (team_id)   WHERE deleted_at IS NULL;

ALTER TABLE services ENABLE ROW LEVEL SECURITY;
CREATE POLICY services_tenant_isolation ON services
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

### 1.3 `labels`

```sql
CREATE TABLE labels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  name        text NOT NULL,
  color       text NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,

  CONSTRAINT labels_name_tenant_unique UNIQUE (tenant_id, name)
  -- analytics: included(id, tenant_id, name, created_at, deleted_at)
);

CREATE INDEX labels_tenant_idx ON labels (tenant_id) WHERE deleted_at IS NULL;

ALTER TABLE labels ENABLE ROW LEVEL SECURITY;
CREATE POLICY labels_tenant_isolation ON labels
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

### 1.4 `ticket_labels`

```sql
CREATE TABLE ticket_labels (
  ticket_instance_id uuid NOT NULL REFERENCES entity_instances(id),
  label_id           uuid NOT NULL REFERENCES labels(id),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  assigned_by        uuid NOT NULL REFERENCES users(id),
  assigned_at        timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (ticket_instance_id, label_id)
  -- analytics: included(ticket_instance_id, label_id, tenant_id, assigned_by, assigned_at)
);

CREATE INDEX ticket_labels_ticket_idx ON ticket_labels (ticket_instance_id);
CREATE INDEX ticket_labels_label_idx  ON ticket_labels (label_id);
CREATE INDEX ticket_labels_tenant_idx ON ticket_labels (tenant_id);

ALTER TABLE ticket_labels ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_labels_tenant_isolation ON ticket_labels
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

### 1.5 `on_call_schedules`

```sql
-- Requires btree_gist extension (already enabled by migration 0001)
CREATE TABLE on_call_schedules (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenants(id),
  team_id                     uuid NOT NULL REFERENCES teams(id),
  label                       text NOT NULL,
  starts_at                   timestamptz NOT NULL,
  ends_at                     timestamptz NOT NULL,
  primary_user_id             uuid NOT NULL,   -- FK to auth users; validated at write time
  backup_user_id              uuid,            -- nullable
  escalation_manager_user_id  uuid,            -- nullable
  created_by                  uuid NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT schedule_window_valid CHECK (ends_at > starts_at),

  -- DB-level overlap prevention: no two entries for the same (tenant, team) can have
  -- overlapping time windows. Requires btree_gist.
  EXCLUDE USING gist (
    tenant_id WITH =,
    team_id   WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  )
  -- analytics: included(id, tenant_id, team_id, starts_at, ends_at, created_at)
);

CREATE INDEX on_call_schedules_team_time_idx
  ON on_call_schedules (tenant_id, team_id, starts_at, ends_at);

ALTER TABLE on_call_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY on_call_schedules_tenant_isolation ON on_call_schedules
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

### 1.6 `notification_policies`

```sql
CREATE TABLE notification_policies (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants(id),
  -- scope dimensions (all nullable; null = "any")
  team_id                   uuid REFERENCES teams(id),
  workflow_type_id          uuid,   -- references workflow type; nullable
  severity                  text NOT NULL
                            CHECK (severity IN ('critical','high','medium','low')),
  channels                  text[] NOT NULL,   -- non-empty subset of known channel names
  notify_backup             boolean NOT NULL DEFAULT true,
  notify_escalation_manager boolean NOT NULL DEFAULT false,
  created_by                uuid NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT channels_not_empty CHECK (cardinality(channels) > 0)
  -- analytics: included(id, tenant_id, team_id, severity, channels, created_at)
);

-- Uniqueness at each specificity level enforced via four partial indexes
-- (composite UNIQUE fails for nullable columns in Postgres: NULL != NULL)
CREATE UNIQUE INDEX notif_policy_global_severity
  ON notification_policies (tenant_id, severity)
  WHERE team_id IS NULL AND workflow_type_id IS NULL;

CREATE UNIQUE INDEX notif_policy_team_severity
  ON notification_policies (tenant_id, team_id, severity)
  WHERE team_id IS NOT NULL AND workflow_type_id IS NULL;

CREATE UNIQUE INDEX notif_policy_workflow_severity
  ON notification_policies (tenant_id, workflow_type_id, severity)
  WHERE team_id IS NULL AND workflow_type_id IS NOT NULL;

CREATE UNIQUE INDEX notif_policy_team_workflow_severity
  ON notification_policies (tenant_id, team_id, workflow_type_id, severity)
  WHERE team_id IS NOT NULL AND workflow_type_id IS NOT NULL;

ALTER TABLE notification_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_policies_tenant_isolation ON notification_policies
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
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

No query params. Returns active schedule entry per team (inner join to all tenant teams).

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

```
for channel in policy.channels:
  try:
    @platform/notifications.send({
      channel,
      recipients,
      subject: buildSubject(ticket, severity),
      payload: buildPayload(ticket),
    })
    // no per-channel audit write on success — covered by the single dispatched entry
  catch:
    writeAuditEntry({ action: 'notification.channel_failed',
                      metadata: { channel, error: err.message } })
    logger.warn({ channel, ticketId, error }, 'notification channel failed')
    // continue — do not abort remaining channels

writeAuditEntry({ action: 'notification.dispatched',
                  metadata: { channels, recipientCount, policyId, matchedAt } })
```

**Idempotency key:** `severity_notify:{ticketId}:{severity_value}` — prevents duplicate
dispatch if the same `entity.updated` event is re-delivered.

---

## 4. Security Model

| Concern                                   | Mechanism                                                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-tenant team data                    | RLS policy on `teams`, `services`, `on_call_schedules`, `notification_policies`; all queries inside `withTenantContext`                      |
| Cross-tenant user references in schedules | At write time, `primary_user_id`/`backup_user_id`/`escalation_manager_user_id` are validated against the tenant's user list before insert    |
| Cross-tenant `entity_ref` on tickets      | Entity engine's built-in cross-tenant reference guard (`CROSS_TENANT_REFERENCE` error code) covers `team_id` and `service_id`                |
| Schedule overlap correctness              | GIST exclusion constraint — not application-layer-only                                                                                       |
| Notification policy write access          | `requireRole("admin")` on all POST/PATCH/DELETE policy routes                                                                                |
| Notification policy slot collision        | Partial unique indexes per specificity level; application-layer check returns `409` before hitting the DB constraint for a clean error       |
| Audit trail                               | Every routing and notification event (success or failure) written to `admin_audit_log` in the same DB transaction as the triggering mutation |

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
| 0092         | `on_call_schedules` table + GIST exclusion + RLS                                                |
| 0093         | `notification_policies` table + partial unique indexes + RLS                                    |
| 0094         | Extend `admin_audit_log` CHECK constraint for `oncall.*` + `notification.*` + `label.*` strings |
| 0095         | Seed: add `severity`, `team_id`, `service_id` system fields to `ticket` entity type             |
| 0096         | `labels` table + RLS + index                                                                    |
| 0097         | `ticket_labels` junction table + RLS + indexes                                                  |

Each migration follows the standard pattern: `docs/migrations/<id>_<slug>.sql` + journal entry.
The GIST exclusion on `on_call_schedules` requires `btree_gist` — confirm it is enabled in the
migration 0001 baseline before landing 0092. If not, add `CREATE EXTENSION IF NOT EXISTS
btree_gist;` at the top of 0092 (safe to run twice).

---

## 8. Testing Checklist

### Unit tests (per package)

- `resolve_oncall`: no schedule → unchanged assignee + audit; active schedule → assignee set;
  explicit assignee + team_id → skipped; idempotent re-delivery → no duplicate write
- `dispatch_severity_notification`: policy resolution scores; fallback to global; fallback to
  email-only default; one channel failing doesn't abort others; idempotent re-delivery
- Notification policy CRUD: overlap collision → 409; empty channels → 422; cross-tenant user
  in schedule → 422

### Integration tests (per route)

- `POST /admin/on-call-schedules`: overlap → 409; invalid window → 422; foreign user → 422
- `GET /admin/on-call-schedules/current`: all teams returned; null oncall for uncovered teams
- `GET /admin/notification-policies/resolve`: returns correct match at each specificity level;
  hardcoded default when no policy exists

### Isolation tests (RLS)

- Teams/services/schedules/policies: Tenant B reads return empty when only Tenant A has data
- `resolve_oncall` action: schedule lookup never crosses tenant boundary
- `dispatch_severity_notification`: policy lookup never crosses tenant boundary

### End-to-end (Docker stack)

- Full ticket lifecycle: create ticket with team_id → assignee set within 5 s
- Full severity flow: patch severity to "critical" → all channels in critical policy dispatch
- Coverage-gap badge: team with no active schedule shows badge in admin UI
