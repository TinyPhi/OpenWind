# On-Call Routing & Roster Scheduler

> Smart ticket routing via on-call schedules — assigns primary on-call, tags backup, prevents single-person bottlenecks.

status: draft
created: 2026-09-06
updated: 2026-09-06

---

## §G Goal

When an agent doesn't know the right owner, they assign a ticket to a **team** and/or **service**.
The system resolves the current on-call roster entry for that team, assigns the ticket to the
**primary on-call**, and notifies the **backup on-call**. Load distributes across the roster week
over week instead of defaulting to whoever was assigned last or is most available-looking.

Done when:

- Admin can define teams, services, and weekly/monthly on-call rosters
- Ticket creation/update with a team assignment triggers auto-resolve + assign within 5 s
- No manual intervention needed once roster is configured
- Any ticket without a team assignment is untouched (existing behaviour preserved)

---

## §C Constraints

| constraint        | value                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack             | TypeScript · Hono · Drizzle ORM · Vitest · BullMQ · pnpm workspaces                                                                                                 |
| auth              | Zitadel JWT; tenant-scoped RLS on all new tables; explicit `WHERE tenant_id` on every query                                                                         |
| entity engine     | reuse for custom field definitions (severity, tags, team_ref, service_ref on ticket type)                                                                           |
| automation engine | new action type `resolve_oncall` hooks into the existing rule executor                                                                                              |
| audit             | all roster changes + auto-assignments written to `admin_audit_log`                                                                                                  |
| perf              | on-call lookup ≤ 100 ms p99 (single indexed query); roster write ≤ 500 ms                                                                                           |
| out of scope      | AI-suggested roster generation, mobile push notifications, multi-timezone auto-DST, SLA-aware escalation paging, external pager integrations (PagerDuty / OpsGenie) |
| custom fields     | entity engine's `addEntityField()` already handles ad-hoc custom fields when `allowCustomFields: true` — no new mechanism needed                                    |

---

## §I Interfaces

### New tables (all tenant-scoped, RLS required)

```
teams
  id uuid PK
  tenant_id uuid FK NOT NULL
  name text NOT NULL
  description text
  created_at / updated_at / deleted_at

services
  id uuid PK
  tenant_id uuid FK NOT NULL
  name text NOT NULL
  description text
  team_id uuid FK teams (optional default owner team)
  created_at / updated_at / deleted_at

on_call_schedules
  id uuid PK
  tenant_id uuid FK NOT NULL
  team_id uuid FK teams NOT NULL
  label text NOT NULL                        -- e.g. "Week 37 2026"
  starts_at timestamptz NOT NULL
  ends_at   timestamptz NOT NULL
  primary_user_id   uuid FK users NOT NULL
  backup_user_id    uuid FK users           -- nullable; optional but recommended
  escalation_manager_user_id uuid FK users  -- nullable
  created_by uuid FK users NOT NULL
  created_at / updated_at

  CONSTRAINT no_overlap: EXCLUDE USING gist (tenant_id WITH =, team_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
```

### New entity fields (added to the `ticket` entity type as system fields)

| field name   | type           | values / notes                         |
| ------------ | -------------- | -------------------------------------- |
| `severity`   | `select`       | `critical` / `high` / `medium` / `low` |
| `tags`       | `multi_select` | free-text values, stored JSONB array   |
| `team_id`    | `entity_ref`   | references `teams` table               |
| `service_id` | `entity_ref`   | references `services` table            |

Custom ad-hoc fields continue via the existing `addEntityField()` path — nothing new required.

### New automation action type

```
resolve_oncall
  input:  team_id field path on the triggering entity
  effect:
    1. query on_call_schedules WHERE team_id = <resolved>
                                AND tenant_id = <ticket tenant>
                                AND starts_at <= now() AND ends_at > now()
                                LIMIT 1
    2. set entity.assignee = primary_user_id
    3. if backup_user_id: add to entity watchers / send notification
    4. write audit entry (action: "oncall.auto_assigned")
  fail-safe: if no active schedule found → leave assignee unchanged,
             emit warning log, write audit entry (action: "oncall.no_schedule")
```

### REST API surface (admin-only writes; agent read-only)

```
GET    /admin/teams                      list teams (paginated, cursor-based)
POST   /admin/teams                      create
PATCH  /admin/teams/:id                  update
DELETE /admin/teams/:id                  soft-delete

GET    /admin/services                   list services (paginated)
POST   /admin/services                   create
PATCH  /admin/services/:id               update
DELETE /admin/services/:id               soft-delete

GET    /admin/on-call-schedules          list schedules (filter: team_id, from, to)
POST   /admin/on-call-schedules          create schedule entry
PATCH  /admin/on-call-schedules/:id      update (reconfigure before window starts)
DELETE /admin/on-call-schedules/:id      delete (hard delete — schedule entries are admin-controlled records)

GET    /admin/on-call-schedules/current  active on-call per team right now (UI dashboard)
```

---

## §R Requirements

### Ticket fields

R1: Ticket entity type ships four new system fields — `severity`, `tags`, `team_id`, `service_id`.
✓ Creating a ticket with `severity: "critical"` stores and returns "critical"
✓ Creating with an unrecognised severity value returns `422` with a field-level error
✓ Tags accept an array of strings; duplicates within one ticket are deduplicated on save
✓ `team_id` references a valid `teams` row in the same tenant; cross-tenant ref returns `422`
✓ `service_id` references a valid `services` row in the same tenant; cross-tenant ref returns `422`
✓ All four fields are optional — tickets without them behave exactly as before (no regression)

R2: System ticket fields cannot be removed or redefined via the custom-field API.
✓ `removeEntityField("severity")` on a ticket type returns a `400` or is blocked at the schema level
✓ `addEntityField` with the same name as a system field returns `409`

### Teams & Services registry

R3: Admins can create, list, update, and soft-delete teams within their tenant.
✓ `POST /admin/teams` returns `201` with the new team; `GET /admin/teams` lists it
✓ Soft-deleting a team hides it from listing but preserves FK integrity on existing schedules/tickets
✓ Duplicate name within a tenant returns `409`

R4: Admins can create, list, update, and soft-delete services; each service may belong to a team.
✓ Same CRUD behaviour as teams
✓ `GET /admin/services` resolves the owning team name inline
✓ Deleting a team does not cascade-delete its services (FK constraint + `409` or `400` if services exist)

### Roster scheduler

R5: Admins define on-call schedule entries covering a team, a time window, and named on-call roles.
✓ Overlapping window for the same team + tenant returns `409`
✓ `starts_at >= ends_at` returns `422`
✓ `primary_user_id` must belong to the same tenant; foreign user returns `422`
✓ A schedule entry spanning Mon–Sun 00:00 UTC is stored and returned with those exact timestamps

R6: Current on-call snapshot returns the active schedule per team as of `now()`.
✓ `GET /admin/on-call-schedules/current` returns one entry per team with an active schedule
✓ Teams with no active schedule appear with `oncall: null` — not omitted
✓ Response includes resolved display names for primary, backup, escalation manager

R7: Schedule listing allows filtering by team and date range.
✓ `GET /admin/on-call-schedules?team_id=X&from=T1&to=T2` returns entries sorted by `starts_at`
✓ No entries in range → empty array `[]`, not `404`

### Auto-assignment

R8: Setting `team_id` on a ticket (create or update) triggers on-call resolution and auto-assigns the ticket.
✓ Ticket created with `team_id` → within 5 s, `assignee` is the primary on-call user
✓ Ticket updated to add/change `team_id` → same auto-assign fires; previous assignee is replaced
✓ Backup on-call receives a notification that they are tagged on the ticket
✓ Both auto-assign and backup tagging appear in the audit log

R9: No active schedule for the team → ticket left unchanged, warning surfaced.
✓ `assignee` remains unchanged (null if new ticket, prior value if update)
✓ Audit log records `oncall.no_schedule` for the team at that timestamp
✓ Admin UI surfaces affected tickets (has `team_id`, no `assignee`) with a coverage-gap badge

R10: Explicit `assignee` on the same request as `team_id` wins; auto-resolution is skipped.
✓ Ticket with both `team_id` and explicit `assignee` in same payload → explicit assignee is used
✓ Audit log records `oncall.skipped_explicit_assignee` (not `oncall.auto_assigned`)

R11: Auto-assignment is idempotent — replaying the same trigger event does not duplicate assignments or audit entries.
✓ Re-delivering the same `entity.updated` event for the same ticket version results in same assignee with no duplicate audit rows

### Security & isolation

R12: All new tables are tenant-scoped; cross-tenant data is never accessible.
✓ Isolation tests: querying teams / services / schedules as Tenant B returns `[]` when only Tenant A has data
✓ `resolve_oncall` action resolves schedules only within the triggering ticket's tenant

R13: Only `admin` role can write teams, services, and schedules; agents get read-only.
✓ `agent` role `POST /admin/teams` → `403`
✓ `agent` role `GET /admin/teams` → `200` (needed for ticket-form dropdowns)

---

## §V Invariants

- Schedule entries never overlap for the same (tenant, team) pair — enforced at DB level via GIST exclusion constraint, not application-layer alone
- `resolve_oncall` is fail-open: lookup failure leaves ticket unchanged, never assigns to a wrong user
- Cross-tenant user references in schedule entries are rejected at write time, not silently stored
- System ticket fields (`severity`, `tags`, `team_id`, `service_id`) survive a schema cache invalidation cycle without data loss
- Auto-assignment audit entries are written in the same DB transaction as the assignment; rolled-back assignments produce no dangling audit entries
- `team_id` field on a ticket is always validated against the same tenant's `teams` table (entity engine cross-tenant-reference guard already covers `entity_ref` fields)

---

## §T Tasks

| id  | task                                                                                          | phase | status | depends  |
| --- | --------------------------------------------------------------------------------------------- | ----- | ------ | -------- |
| T1  | Migration: `teams` table + RLS policy + analytics annotation                                  | 1     | todo   | —        |
| T2  | Migration: `services` table + RLS policy + analytics annotation                               | 1     | todo   | T1       |
| T3  | Migration: `on_call_schedules` table + GIST exclusion + RLS + analytics annotation            | 1     | todo   | T1       |
| T4  | Migration: extend `admin_audit_log` CHECK constraint for `oncall.*` action strings            | 1     | todo   | T3       |
| T5  | Seed SQL: add `severity`, `tags`, `team_id`, `service_id` system fields to ticket entity type | 1     | todo   | T1,T2    |
| T6  | `packages/teams` (or inline in packages/db): CRUD + on-call lookup + tenant guard             | 2     | todo   | T1,T2,T3 |
| T7  | `GET/POST/PATCH/DELETE /admin/teams` routes + Zod schemas + unit + integration tests          | 2     | todo   | T6       |
| T8  | `GET/POST/PATCH/DELETE /admin/services` routes + tests                                        | 2     | todo   | T6       |
| T9  | `GET/POST/PATCH/DELETE /admin/on-call-schedules` routes + overlap validation + tests          | 2     | todo   | T6       |
| T10 | `GET /admin/on-call-schedules/current` snapshot endpoint + tests                              | 2     | todo   | T9       |
| T11 | Isolation tests: cross-tenant schedule / team / service isolation                             | 2     | todo   | T7,T8,T9 |
| T12 | `resolve_oncall` action type in `packages/automation-engine`                                  | 3     | todo   | T6,T9    |
| T13 | Automation rule seed: trigger on `entity.updated` where `team_id` changed → `resolve_oncall`  | 3     | todo   | T12      |
| T14 | Explicit-assignee-wins guard (R10) + idempotency guard (R11)                                  | 3     | todo   | T12      |
| T15 | Backup on-call notification via `@platform/notifications`                                     | 3     | todo   | T12      |
| T16 | Isolation tests: auto-assignment cross-tenant isolation                                       | 3     | todo   | T12,T13  |
| T17 | Admin UI: Teams & Services management pages                                                   | 4     | todo   | T7,T8    |
| T18 | Admin UI: Roster calendar / schedule builder per team                                         | 4     | todo   | T9,T10   |
| T19 | Admin UI: coverage-gap badge on tickets (R9 surface)                                          | 4     | todo   | T13      |
| T20 | Admin UI: ticket form — severity dropdown, tags multi-select, team/service pickers            | 4     | todo   | T5       |

phase gate: all unit + integration + isolation tests pass before advancing to next phase

---

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |

---

_spec is source of truth — update as decisions are made_
