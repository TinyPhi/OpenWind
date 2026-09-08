# Temporal Scheduler — Automatic Ticket Creation on Schedule

> Auto-create tickets at configured dates and times so recurring workflows start without manual intervention.

status: draft
created: 2026-09-07
updated: 2026-09-07

---

## §G Goal

Admins configure **schedule rules** that auto-create one ticket per fire — with workflow,
assignee, team, service, severity, and field values pre-set — on a recurring cron schedule
(daily, weekly, monthly, nth-weekday-of-month, etc.). The system fires each due rule,
creates the ticket, and logs the outcome. No one has to remember; the workflow just starts.

Measurable done: a schedule rule created by an admin fires at the configured time, creates
a correctly-configured ticket within 90 seconds of the scheduled time, and the execution is
logged. Missed fires during worker downtime are skipped by default (not doubled up).

---

## §C Constraints

| constraint           | value                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| stack                | TypeScript · Hono · Drizzle · BullMQ (existing worker) · pino · Vitest · `cron-parser` · `cronstrue` |
| auth                 | Zitadel JWT; admin role required for all schedule rule writes                                        |
| execution engine     | DB-polling approach (same as SLA scheduler); no new external scheduler dependency                    |
| schedule granularity | Minute-level (5-field cron); second-level not supported                                              |
| timezone             | IANA timezone per rule; stored and evaluated in UTC; display in user's timezone                      |
| missed fires         | Skipped by default (`catch_up: false`); `catch_up: true` available, capped at 24 fires               |
| ticket template      | Validated against entity type schema at rule creation **and** at fire time                           |
| title templating     | `{{variable}}` whitelist substitution only — no template engine (SSTI risk)                          |
| out of scope         | One-shot (non-recurring) scheduled tickets; external calendar sync; sub-minute cron                  |
| out of scope         | Auto-creation of any entity type other than ticket (entity_type.slug = 'ticket')                     |
| out of scope         | Scheduling workflow transitions or automation rules — only ticket creation                           |
| performance          | Scheduler tick ≤ 5 s for up to 500 concurrently due rules across all tenants                         |

---

## §I Interfaces

### `schedule_rules`

```
id           uuid PK
tenant_id    uuid FK tenants NOT NULL
name         text NOT NULL — unique per tenant (soft-delete allows reuse)
description  text
-- schedule
cron_expr    text NOT NULL — 5-field standard cron (e.g. "0 9 25 * *")
timezone     text NOT NULL DEFAULT 'UTC' — IANA timezone string
-- ticket template
entity_type_id  uuid FK entity_types NOT NULL — must have slug = 'ticket'
workflow_id     uuid FK workflows (nullable) — null = entity type's default workflow
template     jsonb NOT NULL
  {
    title:       string (required, supports {{date}} {{month}} {{year}} {{rule_name}})
    description: string (optional, same substitution)
    severity:    'critical'|'high'|'medium'|'low' (optional)
    assignee_id: uuid FK users (optional)
    team_id:     uuid FK teams (optional)
    service_id:  uuid FK services (optional)
    fields:      Record<fieldName, value> (optional; validated against entity type schema)
  }
-- state
status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived'))
next_fire_at timestamptz — computed; null when paused/archived
last_fired_at timestamptz
catch_up     boolean NOT NULL DEFAULT false
-- metadata
created_by   uuid FK users NOT NULL
created_at / updated_at / deleted_at
```

### `schedule_executions`

```
id               uuid PK
tenant_id        uuid FK tenants NOT NULL
rule_id          uuid FK schedule_rules NOT NULL
scheduled_at     timestamptz NOT NULL — when it was supposed to fire
fired_at         timestamptz NOT NULL — when it actually fired
status           text NOT NULL CHECK (status IN ('success','failed','skipped'))
entity_instance_id uuid FK entity_instances (nullable) — the created ticket; null on failure
error_code       text — sanitized error code if failed; no raw provider messages
created_at       timestamptz NOT NULL DEFAULT now()
-- analytics: included(id, tenant_id, rule_id, scheduled_at, status, created_at)
```

### Template variable substitution

| variable          | resolves to                                                                        |
| ----------------- | ---------------------------------------------------------------------------------- |
| `{{date}}`        | fire date ISO-8601 in rule's timezone                                              |
| `{{month}}`       | month name (e.g. "October")                                                        |
| `{{month_short}}` | abbreviated month (e.g. "Oct")                                                     |
| `{{year}}`        | 4-digit year                                                                       |
| `{{week}}`        | ISO 8601 week number (1–53, e.g. 43 for late October) — not relative-to-month week |
| `{{rule_name}}`   | the schedule rule's `name` field                                                   |

Unknown `{{tokens}}` are left as-is (not an error).

---

## §R Requirements

**R1** — Admin can create a schedule rule with a cron expression, IANA timezone, and ticket template.
✓ `POST /admin/schedule-rules` with valid body → `201` rule created, `next_fire_at` computed
✓ Invalid cron expression → `422` with `fields.cron_expr` error
✓ Invalid IANA timezone → `422` with `fields.timezone` error
✓ `entity_type_id` not a ticket type → `422`

**R2** — The system auto-creates a ticket within 90 seconds of a rule's `next_fire_at`.
✓ Rule with `next_fire_at = now()` → ticket created, execution logged as `success` within 90 s
✓ Ticket has the correct workflow, assignee, team, service, severity, and field values from template
✓ `next_fire_at` advanced to the next future cron time after firing

**R3** — Title and description support `{{variable}}` substitution at fire time.
✓ Template `"Monthly Review — {{month}} {{year}}"` → `"Monthly Review — October 2026"` when fired in October 2026

**R4** — Schedule rules can be paused, resumed, and archived.
✓ Paused rule: `next_fire_at` set to null; rule does not fire while paused
✓ Resumed rule: `next_fire_at` recomputed from the next cron time after now(); catch-up logic applies if `catch_up: true`
✓ Archived rule: status = 'archived'; cannot be resumed; soft-deleted from active polling

**R5** — Execution history is logged per rule.
✓ `GET /admin/schedule-rules/:id/executions` returns paginated execution records (scheduled_at, fired_at, status, ticket link or error_code)
✓ Failed execution includes `error_code`; no raw error message with PII

**R6** — Admin can preview the next N scheduled fires for a rule (dry-run, no ticket created).
✓ `GET /admin/schedule-rules/:id/next-fires?count=5` returns next 5 fire timestamps in the rule's timezone

**R7** — Failed ticket creation does not crash the worker; next_fire_at is still advanced.
✓ If `createEntityInstance()` throws, execution is logged as `failed`, `next_fire_at` advanced, worker continues to next rule
✓ Worker tick completes even if all rules in the tick fail

**R8** — `catch_up: false` (default): missed fires during worker downtime are skipped.
✓ Worker down for 3 days; rule that should have fired 3 times: `next_fire_at` advanced to next future time; no catch-up tickets created; missed fires logged as `skipped`

**R9** — `catch_up: true`: missed fires during downtime are executed in order, capped at 24.
✓ Worker down for 2 days; rule fires twice daily: up to 4 catch-up tickets created in chronological order; executions logged with original `scheduled_at` values
✓ More than 24 missed fires: only the 24 most recent are caught up; earlier ones logged as `skipped`

**R10** — All schedule rules and executions are strictly tenant-scoped.
✓ Cross-tenant rule read → `404` (not `403`)
✓ Template `team_id`/`assignee_id` from a different tenant → `422` at rule creation
✓ At fire time: ticket created inside same tenant's `withTenantContext`; cross-tenant fields rejected

**R1b** — Schedule rules are soft-deleted; execution history is preserved after deletion.
✓ `DELETE /admin/schedule-rules/:id` sets `deleted_at`; associated `schedule_executions` rows remain queryable

**R1c** — Audit log entry written for every execution outcome.
✓ `schedule.ticket_created { ruleId, ticketId, scheduledAt }` on success
✓ `schedule.execution_failed { ruleId, errorCode, scheduledAt }` on failure

---

## §V Invariants

- A `paused` or `archived` rule never fires — polling query filters by `status = 'active'`
- `next_fire_at` is always set to a future timestamp after a successful or failed execution
- A schedule execution never creates a ticket in another tenant's context — worker sets tenant context from `schedule_rules.tenant_id`, not from caller
- Execution log is append-only — `schedule_executions` rows are never updated or deleted
- Template field values are validated against the entity type schema at rule creation; fire-time re-validation is a safety net — a schema change that invalidates a template logs `failed`, not silent wrong data
- Cron expressions are stored only after passing server-side parse validation (`cron-parser`) — invalid cron never reaches the DB
- Title template substitution uses a closed whitelist — unknown tokens pass through as literals; no eval, no Handlebars, no Mustache
- `catch_up` execution cap is enforced at 24 — no rule ever creates more than 24 tickets in a single catch-up run
- Worker advisory lock prevents two worker instances from processing the same rule concurrently

---

## §T Tasks

| id  | task                                                                                                                            | phase | status | depends |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1  | Migration `0098`: `schedule_rules` table + RLS read/write pair + analytics annotation + soft-delete                             | 1     | todo   | —       |
| T2  | Migration `0099`: `schedule_executions` table + RLS + analytics annotation (append-only, no soft-delete)                        | 1     | todo   | T1      |
| T3  | Migration `0100`: extend `admin_audit_log` CHECK constraint for `schedule.*` action strings                                     | 1     | todo   | T2      |
| T4  | `packages/scheduler` library: cron validation, timezone validation, `next_fire_at` calculator, template renderer, tenant guard  | 2     | todo   | T1,T2   |
| T5  | `GET/POST/PATCH/DELETE /admin/schedule-rules` routes + Zod schemas + unit + integration tests                                   | 2     | todo   | T4      |
| T6  | `GET /admin/schedule-rules/:id/executions` pagination endpoint + tests                                                          | 2     | todo   | T5      |
| T7  | `GET /admin/schedule-rules/:id/next-fires?count=N` dry-run endpoint + tests                                                     | 2     | todo   | T4      |
| T8  | Isolation tests: cross-tenant schedule rule isolation (reads, write blocks, template FK guards)                                 | 2     | todo   | T5,T6   |
| T9  | Scheduler tick in `apps/worker`: poll due rules, advisory lock, create tickets, advance `next_fire_at`, write execution records | 3     | todo   | T4      |
| T10 | catch_up logic: detect missed fires on resume/restart, create in chronological order up to 24, log extras as `skipped`          | 3     | todo   | T9      |
| T11 | Prometheus metrics: register `openwind_schedule_*` counters + histograms + gauge in `packages/telemetry/src/metrics.ts`         | 3     | todo   | T9      |
| T12 | OTel spans: `schedule.tick` + `schedule.create_ticket` spans with full attribute sets                                           | 3     | todo   | T9      |
| T13 | Worker integration tests: tick fires due rule, idempotency, catch-up, failed creation continues worker                          | 3     | todo   | T9,T10  |
| T14 | Isolation tests: cross-tenant execution isolation (worker only creates tickets in correct tenant)                               | 3     | todo   | T9      |
| T15 | Admin UI: Schedule Rules list + create/edit form (cron picker with friendly presets, template fields, timezone selector)        | 4     | todo   | T5,T7   |
| T16 | Admin UI: execution history table per rule — status chips, ticket link, error badge, timestamps in user timezone                | 4     | todo   | T6      |
| T17 | Admin UI: next-fires preview panel in the rule form — shows next 5 scheduled fires in rule's timezone                           | 4     | todo   | T7      |

phase gate: all unit + integration + isolation tests pass before advancing to next phase

---

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |

---

_spec is source of truth — update as decisions are made_
