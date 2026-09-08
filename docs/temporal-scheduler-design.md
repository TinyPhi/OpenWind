# Temporal Scheduler — Design Reference

> Behavioral specification for implementation. Read alongside `docs/specs/temporal-scheduler.md`
> (requirements) and `docs/specs/adr-017-draft-temporal-scheduler.md` (decisions). This doc covers
> data shapes, API contracts, worker algorithm, and sequence flows.

---

## 1. Data Model

### 1.1 `schedule_rules`

```sql
CREATE TABLE schedule_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  name            text NOT NULL,
  description     text,

  -- schedule definition
  cron_expr       text NOT NULL,
  -- 5-field standard cron: minute hour day-of-month month day-of-week
  -- Examples: "0 9 25 * *"       = 9am on the 25th of every month
  --           "0 9 * * 1"        = 9am every Monday
  --           "0 9 1-7 * 2"      = 9am on the first Tuesday of every month
  -- Validated via cron-parser before storage; invalid expressions never reach DB.
  timezone        text NOT NULL DEFAULT 'UTC',
  -- IANA timezone string (e.g. 'Asia/Kolkata', 'America/New_York').
  -- Validated against Intl.supportedValuesOf('timeZone') before storage.

  -- ticket template
  entity_type_id  uuid NOT NULL REFERENCES entity_types(id),
  -- Must resolve to an entity type with slug = 'ticket'.
  -- App-layer ownership check required on POST/PATCH — entity_type_id must belong to the same
  -- tenant AND slug = 'ticket'; FK validation bypasses RLS (same pattern as workflow_id below).
  -- Validated at write time; re-checked at fire time as safety net.
  workflow_id     uuid REFERENCES workflows(id) ON DELETE RESTRICT,
  -- nullable: null = use entity type's default workflow.
  -- No FK enforcement for cross-tenant guard — app-layer check required
  -- (same pattern as notification_policies.workflow_type_id).
  template        jsonb NOT NULL,
  -- See §1.3 Template Schema for full shape and validation rules.

  -- state machine
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','paused','archived')),
  next_fire_at    timestamptz,
  -- Set to the next future cron time on create/resume/update.
  -- Set to null on pause/archive. Never set to a past time.
  last_fired_at   timestamptz,
  catch_up        boolean NOT NULL DEFAULT false,

  -- metadata
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,

  -- analytics: included(id, tenant_id, name, status, next_fire_at, created_at, deleted_at)
);

CREATE UNIQUE INDEX schedule_rules_name_tenant_unique
  ON schedule_rules (tenant_id, name) WHERE deleted_at IS NULL;
CREATE INDEX schedule_rules_due_idx
  ON schedule_rules (next_fire_at) WHERE status = 'active' AND deleted_at IS NULL;
-- ^ hot path index: worker polls WHERE status='active' AND next_fire_at <= now()
CREATE INDEX schedule_rules_tenant_idx
  ON schedule_rules (tenant_id) WHERE deleted_at IS NULL;

ALTER TABLE schedule_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY schedule_rules_tenant_rls ON schedule_rules FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- FOR ALL covers SELECT; a separate FOR SELECT policy is redundant (PostgreSQL ORs permissive
-- policies for the same command). Single policy keeps the migration clean.
```

### 1.2 `schedule_executions`

```sql
CREATE TABLE schedule_executions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  rule_id             uuid NOT NULL REFERENCES schedule_rules(id) ON DELETE RESTRICT,
  scheduled_at        timestamptz NOT NULL,
  -- The time the rule was supposed to fire (from next_fire_at before advancing).
  -- On catch-up, this is the historical missed fire time, not now().
  fired_at            timestamptz NOT NULL DEFAULT now(),
  status              text NOT NULL CHECK (status IN ('success','failed','skipped')),
  entity_instance_id  uuid REFERENCES entity_instances(id),
  -- The created ticket. Null on failure or skipped.
  error_code          text,
  -- Sanitized error identifier (e.g. 'ENTITY_TYPE_NOT_FOUND', 'FIELD_VALIDATION_ERROR').
  -- Never a raw error message. No PII.
  created_at          timestamptz NOT NULL DEFAULT now(),

  -- analytics: included(id, tenant_id, rule_id, scheduled_at, status, created_at)
);

CREATE INDEX schedule_executions_rule_idx
  ON schedule_executions (rule_id, scheduled_at DESC);
CREATE INDEX schedule_executions_tenant_idx
  ON schedule_executions (tenant_id, created_at DESC);

ALTER TABLE schedule_executions ENABLE ROW LEVEL SECURITY;
CREATE POLICY schedule_executions_tenant_rls ON schedule_executions FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

### 1.3 Template Schema

Stored in `schedule_rules.template` (JSONB). Validated with Zod at write time and re-validated
at fire time. Zod schema:

```typescript
const TemplateSchema = z.object({
  title: z.string().trim().min(1).max(500), // trim before min: "   " must fail validation
  description: z.string().trim().max(10000).optional(),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  assignee_id: z.string().uuid().optional(),
  team_id: z.string().uuid().optional(),
  service_id: z.string().uuid().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  // fields values are additionally validated against the entity type's field schema
  // via the entity engine's validateFields() at write time and fire time.
});
```

**Cross-tenant validation at write time:**

- `assignee_id`: must resolve to a user in the same tenant
- `team_id`: must resolve to a team in the same tenant (`teams` table)
- `service_id`: must resolve to a service in the same tenant (`services` table)
- `workflow_id`: must resolve to a workflow in the same tenant (app-layer check — FK bypasses RLS)
- `entity_type_id`: must resolve to an entity type accessible to the tenant with `slug = 'ticket'`
- `fields` values typed as entity_ref: must reference records in the same tenant

### 1.4 `admin_audit_log` new action strings

```sql
'schedule.ticket_created', 'schedule.execution_failed', 'schedule.execution_skipped',
'schedule.rule_paused', 'schedule.rule_resumed', 'schedule.rule_archived'
```

---

## 2. API Reference

All routes under `apps/api/src/routes/admin/`. Auth: `requireAuth()` + `requireRole("admin")`.

### 2.1 Schedule Rules CRUD

#### `GET /admin/schedule-rules`

Query params: `cursor?: uuid`, `limit?: number (1–100, default 20)`, `status?: 'active'|'paused'|'archived'`, `includeDeleted?: boolean`

Response `200`:

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "string",
      "cronExpr": "0 9 25 * *",
      "cronHuman": "At 09:00 on day-of-month 25",
      "timezone": "Asia/Kolkata",
      "status": "active",
      "nextFireAt": "ISO8601",
      "lastFiredAt": "ISO8601|null",
      "catchUp": false,
      "entityTypeId": "uuid",
      "workflowId": "uuid|null",
      "template": { ... }
    }
  ],
  "nextCursor": "uuid|null"
}
```

`cronHuman` is computed server-side via `cronstrue` from `cron_expr`.

#### `POST /admin/schedule-rules`

Body:

```json
{
  "name": "Monthly Leadership Review",
  "description": "Creates the leadership report preparation ticket",
  "cronExpr": "0 9 25 * *",
  "timezone": "Asia/Kolkata",
  "entityTypeId": "uuid",
  "workflowId": "uuid|null",
  "catchUp": false,
  "template": {
    "title": "Leadership Review Prep — {{month}} {{year}}",
    "description": "Prepare slides, revenue summary, and project updates for the {{month}} leadership review.",
    "severity": "high",
    "assignee_id": "uuid",
    "team_id": "uuid",
    "fields": { "due_date": "{{date}}" }
  }
}
```

Response `201`: `{ "data": { ...rule, "nextFireAt": "ISO8601" } }`

Errors:

- `422` invalid cron expression (with `fields.cronExpr` + human-readable parse error)
- `422` invalid IANA timezone
- `422` `entity_type_id` not a ticket type
- `422` cross-tenant `assignee_id`, `team_id`, `service_id`, or `workflow_id`
- `422` template field validation failure against entity type schema
- `409` name already taken by an active rule in this tenant

#### `PATCH /admin/schedule-rules/:id`

All fields optional. If `cronExpr` or `timezone` changes, `next_fire_at` is recomputed.
Response `200`: `{ "data": { ...rule } }`

Special status transitions via PATCH:

- `{ "status": "paused" }` → sets `next_fire_at = null`; audits `schedule.rule_paused`
- `{ "status": "active" }` (from paused) → recomputes `next_fire_at`; audits `schedule.rule_resumed`; if `catch_up: true`, catch-up fires are queued
- `{ "status": "archived" }` → sets `next_fire_at = null`; audits `schedule.rule_archived`; cannot transition back

Errors:

- `409` attempting to un-archive (archived → active/paused)
- `422` same validation as POST

#### `DELETE /admin/schedule-rules/:id`

Soft-delete — sets `deleted_at`. Pauses the rule first (sets `status = 'paused'`, `next_fire_at = null`).
Response `204`. Errors: `404` not found.

### 2.2 Execution History

#### `GET /admin/schedule-rules/:id/executions`

Query params: `cursor?: uuid`, `limit?: number (1–100, default 20)`, `status?: 'success'|'failed'|'skipped'`

Response `200`:

```json
{
  "data": [
    {
      "id": "uuid",
      "scheduledAt": "ISO8601",
      "firedAt": "ISO8601",
      "status": "success",
      "ticket": { "id": "uuid", "title": "string" } | null,
      "errorCode": "string|null"
    }
  ],
  "nextCursor": "uuid|null"
}
```

Ordered by `scheduled_at DESC`.

### 2.3 Next-Fires Dry-Run

#### `GET /admin/schedule-rules/:id/next-fires`

Query params: `count?: number (1–20, default 5)`

Response `200`:

```json
{
  "data": {
    "timezone": "Asia/Kolkata",
    "fires": [
      { "utc": "ISO8601", "local": "2026-10-25T09:00:00+05:30" },
      ...
    ]
  }
}
```

Computes the next `count` cron fires from now using `cron-parser`. No DB write. Rate-limited
per ADR-013's per-tenant tier (JWT-admin routes with no `api_keys` row fall under per-tenant,
not per-key, per ADR-013).

---

## 3. Worker — Scheduler Tick

The scheduler runs as a recurring BullMQ job in `apps/worker`, fired every 60 seconds
by the existing SLA scheduler worker's job registration.

### 3.1 Tick algorithm

```typescript
import { env } from "@platform/config";

const TICK_INTERVAL_MS = env.SCHEDULE_TICK_INTERVAL_SECONDS * 1000;

async function schedulerTick(): Promise<void> {
  const now = new Date();
  const tickStart = Date.now();
  let success = 0,
    failed = 0,
    skipped = 0;

  // system-level cross-tenant poll — intentionally no tenant_id filter;
  // the worker legitimately processes rules for all tenants in one pass.
  const dueRules = await db
    .select()
    .from(scheduleRules)
    .where(
      and(
        eq(scheduleRules.status, "active"),
        lte(scheduleRules.nextFireAt, now),
        isNull(scheduleRules.deletedAt),
      ),
    );

  for (const rule of dueRules) {
    const originalScheduledAt = rule.nextFireAt!;

    // Atomically claim the rule: SELECT FOR UPDATE SKIP LOCKED + advance next_fire_at, all
    // within one transaction. The row lock is held until next_fire_at is advanced and the
    // transaction commits. A second worker that picked up the same row in its own batch SELECT
    // will find the row locked and skip it (SKIP LOCKED), preventing double-fire.
    const claimed = await claimRule(rule, now);
    if (!claimed) continue; // another worker instance already claimed this rule

    // Detect overdue: 2× multiplier avoids misclassifying rules delayed by a slow tick (up to
    // one full TICK_INTERVAL_MS of jitter) as overdue. A rule must be older than two full tick
    // intervals before catch-up handling kicks in.
    const isOverdue =
      originalScheduledAt.getTime() < now.getTime() - 2 * TICK_INTERVAL_MS;

    if (isOverdue) {
      try {
        const ruleSkipped = await withTenantContext(rule.tenantId, () =>
          handleCatchUp(rule, originalScheduledAt, now),
        );
        skipped += ruleSkipped;
      } catch {
        failed++; // handleCatchUp logs the failure; worker continues to next rule
      }
    } else {
      try {
        await withTenantContext(rule.tenantId, () =>
          fireRule(rule, originalScheduledAt, now),
        );
        success++;
      } catch {
        failed++;
        // fireRule logs the failure; worker continues to the next rule
      }
    }
  }

  logger.info(
    {
      totalDue: dueRules.length,
      success,
      failed,
      skipped,
      durationMs: Date.now() - tickStart,
    },
    "scheduler tick complete",
  );
}

// Claim a rule atomically: re-SELECT FOR UPDATE SKIP LOCKED + advance next_fire_at, all in one
// transaction. The lock is held for the duration of the transaction (SELECT → UPDATE → COMMIT),
// guaranteeing exactly-once execution even when two worker instances run concurrently.
// The inner WHERE includes lte(nextFireAt, tickTime) so a sequential worker that picks up the
// same rule after Worker 1 has already advanced next_fire_at sees 0 rows and returns null —
// closing the sequential double-fire race (SKIP LOCKED alone only guards concurrent workers).
// Returns the rule row if claimed; null if another worker already holds the lock or already claimed it.
async function claimRule(
  rule: ScheduleRule,
  tickTime: Date,
): Promise<ScheduleRule | null> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(scheduleRules)
      .where(
        and(
          eq(scheduleRules.id, rule.id),
          eq(scheduleRules.status, "active"),
          lte(scheduleRules.nextFireAt, tickTime), // re-check: guards sequential worker race
        ),
      )
      .for("update", { skipLocked: true })
      .limit(1);

    if (rows.length === 0) return null; // row is locked by another worker — skip

    const nextFireAt = computeNextFireAt(rule.cronExpr, rule.timezone);
    await tx
      .update(scheduleRules)
      .set({ nextFireAt, lastFiredAt: tickTime, updatedAt: tickTime })
      .where(
        // tenant_id filter as defence-in-depth — RLS + explicit filter (dual-layer isolation)
        and(
          eq(scheduleRules.id, rule.id),
          eq(scheduleRules.tenantId, rule.tenantId),
        ),
      );

    return rows[0];
  });
}

// Create one ticket for a single scheduled fire. Does NOT modify schedule_rules — next_fire_at
// was already advanced by claimRule (normal path) or is managed by handleCatchUp (catch-up path).
// Always called from within withTenantContext(rule.tenantId, ...) — tenant GUC is set.
async function fireRule(
  rule: ScheduleRule,
  scheduledAt: Date,
  tickTime: Date,
): Promise<void> {
  const fireStart = Date.now();

  try {
    const title = renderTemplate(
      rule.template.title,
      scheduledAt,
      rule.timezone,
      rule.name,
    );
    const description = rule.template.description
      ? renderTemplate(
          rule.template.description,
          scheduledAt,
          rule.timezone,
          rule.name,
        )
      : undefined;

    // Re-validate template fields against current entity type schema (fire-time safety net).
    await validateTemplate(rule);

    // createEntity signature: createEntity(db, tenantId, input) — engine.ts:226
    // assignedTo is a top-level input field, not embedded in fields (entity engine strips
    // unrecognised field keys silently — passing assignee_id inside fields would be lost).
    const instance = await createEntity(db, rule.tenantId, {
      entityTypeId: rule.entityTypeId,
      workflowId: rule.workflowId ?? undefined,
      assignedTo: rule.template.assigneeId, // top-level; NOT fields.assignee_id
      fields: {
        ...rule.template.fields,
        title,
        description,
        ...(rule.template.severity ? { severity: rule.template.severity } : {}),
        ...(rule.template.teamId ? { team_id: rule.template.teamId } : {}),
        ...(rule.template.serviceId
          ? { service_id: rule.template.serviceId }
          : {}),
      },
      createdBy: rule.createdBy, // ticket attributed to rule's creator (ADR-017 Decision 5)
    });

    await db.insert(scheduleExecutions).values({
      tenantId: rule.tenantId,
      ruleId: rule.id,
      scheduledAt,
      firedAt: tickTime,
      status: "success",
      entityInstanceId: instance.id,
    });

    await writeAuditLog("schedule.ticket_created", {
      ruleId: rule.id,
      ticketId: instance.id,
      scheduledAt,
    });

    logger.info(
      {
        tenantId: rule.tenantId,
        ruleId: rule.id,
        ticketId: instance.id,
        scheduledAt,
        durationMs: Date.now() - fireStart,
      },
      "schedule rule fired",
    );
  } catch (err) {
    const errorCode = classifyScheduleError(err);

    await db.insert(scheduleExecutions).values({
      tenantId: rule.tenantId,
      ruleId: rule.id,
      scheduledAt,
      firedAt: tickTime,
      status: "failed",
      errorCode,
    });

    await writeAuditLog("schedule.execution_failed", {
      ruleId: rule.id,
      errorCode,
      scheduledAt,
    });

    logger.warn(
      { tenantId: rule.tenantId, ruleId: rule.id, errorCode, scheduledAt },
      "schedule rule fire failed",
    );
    throw err; // re-throw so schedulerTick can count failures; outer loop does NOT rethrow
  }
}
```

### 3.2 `computeNextFireAt`

```typescript
import { parseExpression } from "cron-parser";

function computeNextFireAt(cronExpr: string, timezone: string): Date {
  const interval = parseExpression(cronExpr, {
    currentDate: new Date(),
    tz: timezone,
  });
  return interval.next().toDate();
}
```

### 3.3 `renderTemplate`

```typescript
const TEMPLATE_VARS: Record<
  string,
  (d: Date, tz: string, ruleName: string) => string
> = {
  date: (d, tz) => formatInTimeZone(d, tz, "yyyy-MM-dd"),
  month: (d, tz) => formatInTimeZone(d, tz, "MMMM"),
  month_short: (d, tz) => formatInTimeZone(d, tz, "MMM"),
  year: (d, tz) => formatInTimeZone(d, tz, "yyyy"),
  week: (d, tz) => formatInTimeZone(d, tz, "II"), // ISO 8601 week number (1–53), not relative-to-month
  rule_name: (_, __, name) => name,
};

function renderTemplate(
  template: string,
  fireDate: Date,
  tz: string,
  ruleName: string,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const fn = TEMPLATE_VARS[key];
    return fn ? fn(fireDate, tz, ruleName) : match; // unknown tokens: pass through
  });
}
```

`date-fns-tz`'s `formatInTimeZone` is used for timezone-aware formatting. No `eval`, no
template engine.

### 3.4 `classifyScheduleError`

Maps known error types to stable `error_code` strings. Never stores raw `err.message`.

| exception type           | error_code               |
| ------------------------ | ------------------------ |
| `ENTITY_TYPE_NOT_FOUND`  | `ENTITY_TYPE_NOT_FOUND`  |
| `WORKFLOW_NOT_FOUND`     | `WORKFLOW_NOT_FOUND`     |
| `FIELD_VALIDATION_ERROR` | `FIELD_VALIDATION_ERROR` |
| `ASSIGNEE_NOT_IN_TENANT` | `ASSIGNEE_NOT_IN_TENANT` |
| `TEAM_NOT_IN_TENANT`     | `TEAM_NOT_IN_TENANT`     |
| any other / unknown      | `INTERNAL_ERROR`         |

### 3.5 Catch-up on resume / worker restart

Called by `schedulerTick` when a rule's `originalScheduledAt` is older than one tick interval
(i.e. the rule was not fired in the previous tick cycle). `next_fire_at` has already been
advanced to the next future time by `claimRule`. Always called from within
`withTenantContext(rule.tenantId, ...)` — tenant GUC is set for all DB operations inside.

```typescript
import { env } from "@platform/config";

// Read from @platform/config (add SCHEDULE_CATCH_UP_MAX: z.coerce.number().int().min(1).max(100).default(24))
const CATCH_UP_MAX = env.SCHEDULE_CATCH_UP_MAX;

// originalScheduledAt: the rule's next_fire_at value at the time the tick picked it up
//   (before claimRule advanced it). Used to enumerate all missed fire slots.
// Returns the number of fires skipped in this catch-up run (for tick-level skipped counter).
async function handleCatchUp(
  rule: ScheduleRule,
  originalScheduledAt: Date,
  now: Date,
): Promise<number> {
  const missedFires = getMissedFires(
    rule.cronExpr,
    rule.timezone,
    originalScheduledAt,
    now,
  );

  if (!rule.catchUp) {
    // catch_up: false — skip all missed fires; log up to CATCH_UP_MAX individually to avoid
    // unbounded DB writes when the worker was down for a long time (e.g. a daily rule missed
    // for a year = 365 inserts). Fires beyond the cap are counted but not logged individually.
    const toLog = missedFires.slice(-CATCH_UP_MAX);
    const silentlyDropped = missedFires.length - toLog.length;
    for (const scheduledAt of toLog) {
      await db.insert(scheduleExecutions).values({
        tenantId: rule.tenantId,
        ruleId: rule.id,
        scheduledAt,
        firedAt: now,
        status: "skipped",
      });
      await writeAuditLog("schedule.execution_skipped", {
        ruleId: rule.id,
        scheduledAt,
      });
      logger.info(
        { tenantId: rule.tenantId, ruleId: rule.id, scheduledAt },
        "catch-up fire skipped (catch_up: false)",
      );
    }
    if (silentlyDropped > 0) {
      logger.info(
        { tenantId: rule.tenantId, ruleId: rule.id, silentlyDropped },
        "catch-up skip backlog over cap — oldest fires not individually logged",
      );
    }
    return missedFires.length; // total skipped (including those not individually logged)
  }

  // catch_up: true — execute up to CATCH_UP_MAX; log the rest as skipped.
  const toExecute = missedFires.slice(-CATCH_UP_MAX); // most recent N if > cap
  const toSkip = missedFires.slice(0, missedFires.length - toExecute.length);

  // Log over-cap fires as skipped (already inside withTenantContext — GUC is set).
  for (const scheduledAt of toSkip) {
    await db.insert(scheduleExecutions).values({
      tenantId: rule.tenantId,
      ruleId: rule.id,
      scheduledAt,
      firedAt: now,
      status: "skipped",
    });
    await writeAuditLog("schedule.execution_skipped", {
      ruleId: rule.id,
      scheduledAt,
    });
    logger.info(
      { tenantId: rule.tenantId, ruleId: rule.id, scheduledAt },
      "catch-up fire skipped (over cap)",
    );
  }

  // Execute missed fires in chronological order using fireRule — not processRule.
  // fireRule does NOT modify next_fire_at; claimRule already advanced it once.
  for (const scheduledAt of toExecute) {
    try {
      await fireRule(rule, scheduledAt, now);
    } catch {
      // fireRule logs the failure; continue to the next catch-up fire
    }
  }

  return toSkip.length; // fires skipped due to over-cap
}
```

---

## 4. Security Model

| Concern                                       | Mechanism                                                                                                                                                                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-tenant rule access                      | RLS policy (nullif-guarded FOR ALL) on both tables; all API queries inside `withTenantContext`                                                                                                                         |
| Cross-tenant template references (team, user) | `POST/PATCH` validates `assignee_id`, `team_id`, `service_id` belong to the same tenant before storage; app-layer check (same FK-bypass-RLS pattern as services/labels)                                                |
| Cross-tenant `workflow_id`                    | App-layer ownership check on `POST/PATCH` — `workflow_id` must belong to the same tenant; no FK constraint (FK bypasses RLS — same documented pattern as notification_policies)                                        |
| Cross-tenant `entity_type_id`                 | App-layer ownership check on `POST/PATCH` — `entity_type_id` must belong to the same tenant AND `slug = 'ticket'`; no FK constraint (FK validation bypasses RLS — same pattern as `workflow_id`; see §1.1 SQL comment) |
| Worker cross-tenant SELECT (intentional)      | `schedulerTick` polls all tenants without a tenant filter — deliberate system-level exception; annotated in code; per-rule `claimRule()` UPDATE always includes `AND tenant_id = rule.tenantId` as defence-in-depth    |
| Ticket creation in wrong tenant at fire time  | Worker sets `withTenantContext(rule.tenantId)` from the rule row itself — never from caller context; the ticket inherits the rule's tenant                                                                             |
| Title template injection                      | Closed-whitelist `{{variable}}` substitution via regex replace; no eval, no Handlebars/Mustache; unknown tokens pass through as literals                                                                               |
| Invalid cron expression DoS                   | `cron-parser` validation at write time; invalid expressions rejected with `422`; never stored                                                                                                                          |
| Catch-up runaway (flood of tickets)           | Hard cap of `SCHEDULE_CATCH_UP_MAX` (default 24) executions per catch-up run; excess fires logged as `skipped`                                                                                                         |
| Concurrent worker execution (rolling deploy)  | Per-rule transaction: SELECT FOR UPDATE SKIP LOCKED + advance `next_fire_at` committed atomically; lock held until `next_fire_at` is advanced, preventing double-fire                                                  |
| Execution error PII                           | `classifyScheduleError()` maps to stable codes; raw `err.message` never stored in `schedule_executions.error_code` or written to audit log                                                                             |
| Admin-only writes                             | `requireRole("admin")` on all POST/PATCH/DELETE schedule rule routes                                                                                                                                                   |
| Rate limiting on next-fires endpoint          | `GET /admin/schedule-rules/:id/next-fires` rate-limited per ADR-013's per-tenant tier (JWT-admin routes with no `api_keys` row fall under per-tenant tier per ADR-013, not per-key)                                    |

---

## 5. Environment Variables

```
# Add to packages/config/src/env.ts (Zod schema, required before Phase 3 worker work):
SCHEDULE_CATCH_UP_MAX=24           # z.coerce.number().int().min(1).max(100).default(24)
SCHEDULE_TICK_INTERVAL_SECONDS=60  # z.coerce.number().int().min(10).max(3600).default(60)
```

Read via `import { env } from "@platform/config"` — never `process.env` directly (code-style.md).
Both are optional with defaults; the scheduler works without them in `.env`.

---

## 6. Sequence Diagrams

### 6.1 Normal tick — rule fires on schedule

```
Worker tick (60s)    DB (schedule_rules)    Entity engine          DB (schedule_executions)
     |                      |                    |                          |
     | SELECT FOR UPDATE     |                    |                          |
     | SKIP LOCKED           |                    |                          |
     | WHERE next_fire_at    |                    |                          |
     |   <= now()            |                    |                          |
     |---------------------->|                    |                          |
     |   [rule rows]         |                    |                          |
     |<----------------------|                    |                          |
     |                       |                    |                          |
     | UPDATE next_fire_at   |                    |                          |
     | (advance immediately) |                    |                          |
     |---------------------->|                    |                          |
     |                       |                    |                          |
     | renderTemplate()      |                    |                          |
     | validateTemplate()    |                    |                          |
     |                       |                    |                          |
     | createEntity()        |                    |                          |
     |-------------------------------------------->|                         |
     |                       |          [ticket created]                     |
     |<--------------------------------------------|                         |
     |                       |                    |                          |
     | INSERT execution      |                    |                          |
     | (status: success)     |                    |                          |
     |-------------------------------------------------------------->|       |
     | writeAuditLog         |                    |                  |       |
     |                       |                    |                  |       |
```

### 6.2 Fire failure — worker continues

```
Worker tick          DB (schedule_rules)    Entity engine          DB (schedule_executions)
     |                      |                    |                          |
     | [same lock + advance]|                    |                          |
     |                       |                    |                          |
     | createEntity()        |                    |                          |
     |-------------------------------------------->|                         |
     |          [throws FIELD_VALIDATION_ERROR]   |                          |
     |<--------------------------------------------|                         |
     |                       |                    |                          |
     | classifyScheduleError()|                   |                          |
     | INSERT execution      |                    |                          |
     | (status: failed,      |                    |                          |
     |  error_code: FIELD_   |                    |                          |
     |  VALIDATION_ERROR)    |                    |                          |
     |-------------------------------------------------------------->|       |
     | writeAuditLog(failed) |                    |                  |       |
     | logger.warn()         |                    |                  |       |
     |                       |                    |                  |       |
     | [continue to next rule — no rethrow]       |                  |       |
     |                       |                    |                  |       |
```

---

## 7. Migration Sequence

> **Migration numbers are provisional.** Migrations 0090–0091 are already occupied by
> `api_keys_rls_null_safe_tenant_guc` and `origin_tagging_columns`. The 3E on-call routing track
> (`docs/oncall-routing-design.md`) needs 8 migrations; accounting for the two taken numbers its
> actual range will be 0092–0099. 3F therefore starts at 0100. Final numbers must be verified
> against `packages/db/migrations/` at implementation time.

| Migration | Contents                                                                             |
| --------- | ------------------------------------------------------------------------------------ |
| `0100`    | `schedule_rules` table + RLS read/write policy pair + indexes + analytics annotation |
| `0101`    | `schedule_executions` table + RLS + indexes + analytics annotation                   |
| `0102`    | Extend `admin_audit_log` CHECK constraint for `schedule.*` action strings            |

---

## 8. Test Coverage

### 8.1 Unit test scenarios

**`renderTemplate()`:**

| input template                  | fire date         | timezone         | expected output                             |
| ------------------------------- | ----------------- | ---------------- | ------------------------------------------- |
| `"Review — {{month}} {{year}}"` | 2026-10-25T04:00Z | Asia/Kolkata     | `"Review — October 2026"`                   |
| `"Week {{week}} report"`        | 2026-10-19T04:00Z | Asia/Kolkata     | `"Week 43 report"`                          |
| `"Report {{unknown}} token"`    | any               | any              | `"Report {{unknown}} token"` (pass-through) |
| `"Sync — {{date}}"`             | 2026-10-01T03:30Z | America/New_York | `"Sync — 2026-09-30"` (previous day in NY)  |

**`computeNextFireAt()`:**

| cron_expr    | timezone         | from (UTC)        | expected next (local)             |
| ------------ | ---------------- | ----------------- | --------------------------------- |
| `0 9 25 * *` | Asia/Kolkata     | 2026-10-24T10:00Z | 2026-10-25T09:00+05:30            |
| `0 9 * * 1`  | America/New_York | 2026-10-05T12:00Z | 2026-10-12T09:00-04:00 (next Mon) |
| `0 0 1 * *`  | UTC              | 2026-10-31T23:00Z | 2026-11-01T00:00Z                 |

**`TemplateSchema` validation:**

| input                                  | expected outcome                               |
| -------------------------------------- | ---------------------------------------------- |
| `title: "   "` (whitespace-only)       | `422` — trim + min(1) rejects whitespace title |
| `title: "  Monthly Review  "` (padded) | stored as `"Monthly Review"` after trim        |
| `title: ""` (empty string)             | `422` — min(1) violation                       |

**`classifyScheduleError()`:**

| thrown error                    | expected error_code      |
| ------------------------------- | ------------------------ |
| `EntityTypeNotFoundError`       | `ENTITY_TYPE_NOT_FOUND`  |
| `FieldValidationError`          | `FIELD_VALIDATION_ERROR` |
| `Error('something unexpected')` | `INTERNAL_ERROR`         |

**`handleCatchUp()` — catch_up: false:**

| scenario                        | expected outcome                            |
| ------------------------------- | ------------------------------------------- |
| 3 missed fires, catch_up: false | 3 `skipped` executions, next_fire_at future |
| 0 missed fires                  | no executions, next_fire_at advanced        |

**`handleCatchUp()` — catch_up: true:**

| scenario                            | expected outcome                                    |
| ----------------------------------- | --------------------------------------------------- |
| 3 missed fires, catch_up: true      | 3 `success` executions, 3 tickets created           |
| 30 missed fires, catch_up: true     | 6 `skipped` + 24 `success`; most recent 24 executed |
| 1 missed fire fails, catch_up: true | 1 `failed` execution; next fire still attempted     |

**`processRule()` — tick behavior:**

| scenario                                  | expected outcome                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| Rule fires successfully                   | ticket created; execution logged `success`; next_fire_at advanced             |
| `createEntity` throws                     | no ticket; execution logged `failed`; next_fire_at still advanced; no rethrow |
| Template re-validation fails at fire time | execution logged `failed` with `FIELD_VALIDATION_ERROR`                       |
| Rule paused mid-tick (status changed)     | lock skips it (FOR UPDATE SKIP LOCKED); no execution                          |

### 8.2 Integration test scenarios

**Schedule rule CRUD:**

- `POST` with valid body → `201`, `nextFireAt` is in the future
- `POST` with invalid cron → `422` with field error
- `POST` with unknown IANA timezone → `422`
- `POST` with `entity_type_id` not ticket type → `422`
- `POST` with `team_id` from different tenant → `422`
- `POST` duplicate name → `409`
- `PATCH` status `active → paused` → `next_fire_at` null; rule not in next tick
- `PATCH` status `paused → active` → `next_fire_at` recomputed to future
- `PATCH` status `archived → active` → `409`
- `DELETE` → soft-delete; rule not in next tick; executions still queryable
- `GET /executions` → paginated; ordered by `scheduled_at DESC`
- `GET /next-fires?count=3` → returns 3 future timestamps in rule's timezone

**Worker tick integration:**

- Insert due rule; run tick; assert ticket created, execution `success`, `next_fire_at` advanced
- Insert due rule; `createEntityInstance` mocked to throw; run tick; assert execution `failed`, next rule in batch still processed
- Two worker instances tick concurrently; assert rule fired exactly once (SELECT FOR UPDATE SKIP LOCKED)

### 8.3 Isolation tests

| table                  | scenario                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `schedule_rules`       | Tenant A cannot read Tenant B's rules                                                                                |
| `schedule_rules`       | Tenant A's write cannot set `tenant_id` to Tenant B                                                                  |
| `schedule_executions`  | Tenant A cannot read Tenant B's executions                                                                           |
| Worker                 | Rule in Tenant A fires; ticket created in Tenant A's context; Tenant B unaffected                                    |
| Template FK guard      | `POST` with Tenant B's `team_id` as Tenant A → `422` (app-layer check before insert)                                 |
| `entity_type_id` guard | `POST` with Tenant B's `entity_type_id` as Tenant A → `422` (app-layer ownership check, FK bypasses RLS)             |
| Concurrent workers     | Two `schedulerTick` instances race on same rule via `Promise.all`; assert exactly one `schedule_executions` row      |
| Catch-up routing       | Rule with `next_fire_at` 2× intervals in the past; assert `schedulerTick` calls `handleCatchUp`, not just `fireRule` |

### 8.4 E2E scenarios

| scenario                                                                                    | timing assertion           |
| ------------------------------------------------------------------------------------------- | -------------------------- |
| Create active rule with `next_fire_at = now()`; poll until execution appears                | ticket created within 90 s |
| Pause rule; wait for scheduled time; resume; assert no missed-fire ticket (catch_up: false) | no spurious ticket         |
| Set `catch_up: true`; pause; advance clock 2 fires; resume; assert 2 tickets                | both within 120 s          |
| Create rule; `GET /next-fires?count=5`; assert 5 future timestamps                          | response within 500 ms     |

---

## 9. Observability

### 9.1 Structured logging

Object-first pino fields per context:

| context                 | mandatory fields                                              | forbidden fields                     |
| ----------------------- | ------------------------------------------------------------- | ------------------------------------ |
| Rule fired successfully | `tenantId`, `ruleId`, `ticketId`, `scheduledAt`, `durationMs` | template field values, assignee name |
| Rule fire failed        | `tenantId`, `ruleId`, `errorCode`, `scheduledAt`              | raw `err.message`, any PII           |
| Catch-up fire skipped   | `tenantId`, `ruleId`, `scheduledAt`                           | —                                    |
| Tick completed          | `totalDue`, `success`, `failed`, `skipped`, `durationMs`      | —                                    |

### 9.2 Prometheus metrics

| metric                                    | type      | labels             | notes                                      |
| ----------------------------------------- | --------- | ------------------ | ------------------------------------------ |
| `openwind_schedule_execution_total`       | Counter   | `tenant`, `status` | `status`: `success` / `failed` / `skipped` |
| `openwind_schedule_execution_duration_ms` | Histogram | `tenant`, `status` | From SELECT to ticket created              |
| `openwind_schedule_rules_active`          | Gauge     | `tenant`           | Refreshed each tick from live count        |
| `openwind_schedule_tick_duration_ms`      | Histogram | —                  | Full tick wall-clock time                  |
| `openwind_schedule_catch_up_total`        | Counter   | `tenant`, `action` | `action`: `executed` / `skipped_over_cap`  |

### 9.3 OTel spans

**`schedule.tick`** (INTERNAL span, one per worker tick):

| attribute              | value                           |
| ---------------------- | ------------------------------- |
| `schedule.rules_due`   | count of due rules in this tick |
| `schedule.success`     | count succeeded                 |
| `schedule.failed`      | count failed                    |
| `schedule.skipped`     | count skipped (catch-up: false) |
| `schedule.duration_ms` | tick wall-clock time            |

**`schedule.create_ticket`** (INTERNAL child span, one per rule per tick):

| attribute               | value                                   |
| ----------------------- | --------------------------------------- |
| `tenant.id`             | tenant UUID                             |
| `schedule.rule_id`      | rule UUID                               |
| `schedule.scheduled_at` | ISO-8601 scheduled fire time            |
| `schedule.outcome`      | `success` / `failed` / `skipped`        |
| `schedule.error_code`   | error code if failed; omitted otherwise |

### 9.4 Grafana dashboard and alert rules

**Dashboard panels (add to existing On-Call Routing row or new "Automation" row):**

1. Schedule execution rate (success / failed / skipped stacked) — 24h window
2. Execution success rate % — target ≥ 99%
3. Tick duration p99 — target ≤ 5 s
4. Execution duration p99 — target ≤ 10 s
5. Active rules by tenant — gauge
6. Catch-up executions over cap (skipped due to > 24 cap) — should be near 0

**Note on metric naming:** The platform uses `_ms` suffix for duration histograms (consistent with
3D's existing metrics). OTel semconv prefers `_seconds` — this is a documented intentional deviation.
`ScheduleTickDurationSLOBreach` alert PromQL references `openwind_schedule_tick_duration_ms` — ensure
this matches the metric name registered in `packages/telemetry/src/metrics.ts`.

**Alert rules (`prometheus/alerts/schedule.yml`):**

| rule name                            | condition                                                                                                                       | severity |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `ScheduleExecutionFailureRateHigh`   | `rate(openwind_schedule_execution_total{status="failed"}[10m]) / rate(openwind_schedule_execution_total[10m]) > 0.10` for 5 min | warning  |
| `ScheduleTickDurationSLOBreach`      | `histogram_quantile(0.99, openwind_schedule_tick_duration_ms) > 5000` for 5 min                                                 | warning  |
| `ScheduleExecutionDurationSLOBreach` | `histogram_quantile(0.99, openwind_schedule_execution_duration_ms) > 10000` for 5 min                                           | warning  |

---

## 10. Tenant Purge Ordering

`apps/worker/src/tenant-purge.ts` deletes tenant data in FK dependency order (per ADR-007). The two
new tables must be inserted into the purge sequence **before** `tenants` is deleted:

```
schedule_executions   -- deleted first (references schedule_rules via RESTRICT FK)
schedule_rules        -- deleted second (references tenants)
tenants               -- deleted last
```

`schedule_executions.rule_id` uses `ON DELETE RESTRICT` — attempting to delete `schedule_rules`
before `schedule_executions` will raise a FK violation at runtime, silently failing any tenant
purge that touches these tables.

**Action required:** Phase 1 migration tasks T1/T2 must include updating `tenant-purge.ts` to
add `DELETE FROM schedule_executions WHERE tenant_id = $tenantId` (before schedule_rules) and
`DELETE FROM schedule_rules WHERE tenant_id = $tenantId` in the correct order. Reference
ADR-007 §Purge ordering for the full deletion sequence.
