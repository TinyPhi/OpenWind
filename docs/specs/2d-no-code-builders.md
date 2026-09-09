# 2D — No-Code Builders + Reporting

> Config-driven tools for admins to build workflows and automation rules, and for agents to save, filter, and export data — without writing code.

status: approved
created: 2026-06-16
updated: 2026-06-16

---

## §G Goal

Phase 2 exit gate. Pilot customer can:

- Build and modify workflows on a drag-and-drop canvas (admin)
- Create and manage automation rules through a form UI (admin)
- Save named filter+sort views on any entity list (agent/customer)
- Export any entity list as CSV, Excel, or PDF (agent/customer)
- View per-tenant and per-user performance dashboards via Metabase (admin/agent)

All builders write to tables the existing engines already read — zero new engine code.

---

## §C Constraints

| constraint     | value                                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| stack          | React + Refine (admin-ui), React (portal), Hono API, Drizzle, Postgres                                                                 |
| canvas lib     | ReactFlow (MIT) — preferred; fall back to form-based if timeline at risk                                                               |
| excel export   | SheetJS (xlsx community) streamed from API — **NOTE: SheetJS CE is SSPL v1; evaluate ExcelJS (MIT) as drop-in alternative before T4**  |
| pdf export     | pdfkit, server-side, landscape for wide tables                                                                                         |
| metabase       | OSS (free), add to docker-compose, signed JWT embedding tokens                                                                         |
| export row cap | 10 000 rows hard limit; warning banner at 5 000                                                                                        |
| large export   | async: queue job → notify user → download link (avoids browser timeout)                                                                |
| auth           | all existing `requireAuth()` + `requireRole()` middleware — no new auth primitives                                                     |
| out of scope   | AI rule generation (3C), live rule simulation, scheduled/emailed reports, public share links for views, per-field Metabase permissions |

---

## §I Interfaces

### Automation rule shape (existing `automation_rules` table)

```
triggerType: string          // "entity.created" | "entity.updated" | "workflow.transitioned" | ...
triggerConfig: JSONB         // { entityTypeId, fieldName?, fromState?, toState? }
conditions: JSONB | null     // [{ field, op, value }]
actions: JSONB               // [{ type: "notify"|"set_field"|"transition", config }]
priority: int                // lower = higher priority; exposed in builder
isEnabled: bool
```

### Saved view shape (new `saved_views` table)

```
id, tenant_id, entity_type_id, created_by (user_id FK ON DELETE SET NULL),
name, filters JSONB, sort JSONB,
is_shared bool,
created_at, updated_at
```

### Export API

```
GET /entities/:typeId/export?format=csv|xlsx|pdf&[filter params]
→ 200 file stream  (sync, ≤ 5 000 rows)
→ 202 { jobId }   (async, > 5 000 rows)

GET /exports/:jobId/download
→ 200 signed URL redirect when ready
→ 202 { status: "pending" } while processing
```

### Metabase embedding

```
GET /metabase/embed-token?dashboard=tenant|user
→ { token, embedUrl }   // signed JWT, 10-min TTL, auto-refreshed by UI
```

### Saved views API

```
GET    /saved-views?entityTypeId=
POST   /saved-views          { name, entityTypeId, filters, sort, isShared }
PATCH  /saved-views/:id
DELETE /saved-views/:id
```

---

## §R Requirements

### Export

R1: Any entity list can be exported as CSV, Excel (.xlsx), or PDF
✓ Download starts within 3 s for ≤ 5 000 rows (sync stream)
✓ Returns `202 { jobId }` for > 5 000 rows; UI polls and shows "preparing export" state
✓ All three formats contain identical row data
✓ Active filters from the list view are applied to the export — export never returns more rows than the visible list

R2: Export respects tenant isolation
✓ Row set is scoped to `tenantId` from auth context — impossible to export cross-tenant rows
✓ Isolation test: Tenant A export request cannot return Tenant B rows even with a crafted `entityTypeId`

R3: PDF handles wide tables gracefully
✓ Landscape orientation when column count > 6
✓ Column headers truncated at 20 chars with ellipsis; cell values truncated at 40 chars

R4: Export cap enforced
✓ Requests for > 10 000 rows return `400 { error: "EXPORT_TOO_LARGE" }` with message explaining the limit
✓ UI shows warning banner when filtered list count is between 5 000 and 10 000

---

### Saved Views

R5: Any user can save a named filter+sort combination on an entity list
✓ Saved view persists across sessions (page reload, new browser tab)
✓ View name is unique per user per entity type (duplicate name → inline validation error)

R6: Saved views can be shared with all agents on the same tenant
✓ Shared view appears in the view selector for all users on that tenant
✓ Only the owner or a tenant admin can edit or delete a shared view
✓ Deleting the owner's account does not delete shared views — ownership transfers to `null` (view persists)

R7: Saved views are tenant-isolated
✓ Isolation test: Tenant A's shared views do not appear for Tenant B users with the same entity type slug

---

### Automation Rule Builder

R8: Admin can create an automation rule via UI without writing JSON
✓ Trigger picker covers all `triggerType` values exposed by the automation engine
✓ Condition builder supports: equals, not equals, contains, greater than, less than, is empty
✓ Action builder supports all three action types: notify, set_field, transition
✓ Saved rule appears in `/automation-rules` list immediately

R9: Rules can be toggled on/off without deleting
✓ Toggle updates `is_enabled` in < 500 ms with optimistic UI
✓ Disabled rule does not fire (verified by existing automation engine tests)

R10: Priority order is visible and editable
✓ Rules list shows priority value; admin can drag-to-reorder or set numeric value
✓ Priority change persists after page reload

R11: Builder is extensible — new trigger types and action types can be added without rewriting the builder
✓ Trigger types and action types are driven by a config registry (not hardcoded switch/case in UI)
✓ Adding a new entry to the registry adds it to all dropdowns with no other UI changes

---

### Workflow Canvas Editor

R12: Admin can view a workflow as a canvas with states as nodes and transitions as edges
✓ Canvas renders all states and transitions for a workflow on load
✓ Layout is auto-arranged on first load (dagre or similar); positions saved on manual drag

R13: Admin can add, rename, and delete states via the canvas
✓ New state appears as a node immediately; persisted on save
✓ Deleting a state that has active instances shows a blocking error (`WORKFLOW_STATE_IN_USE`), does not delete
✓ Terminal states visually distinguished (e.g. double-border or filled)

R14: Admin can add and edit transitions by drawing edges
✓ Drawing an edge from node A to node B opens a transition config panel: label, allowed roles, required fields, SLA hours
✓ Circular transitions (A → B → A) are valid and render without visual glitch

R15: Workflow changes are saved atomically
✓ Canvas save either persists all changes or none — partial saves never occur
✓ Unsaved changes are indicated (dirty state badge); navigating away prompts confirmation

R16: Canvas degrades gracefully on large workflows
✓ Workflows with up to 20 states and 40 transitions render without layout thrashing
✓ Workflows beyond this threshold show a warning and fall back to the form-based list editor

---

### Metabase Dashboards

R17: Metabase OSS runs as a docker-compose service; admin UI embeds dashboards via signed JWT
✓ `docker compose up` starts Metabase alongside existing services
✓ Embedded iframe renders in admin UI without requiring a separate Metabase login

R18: Tenant dashboard is scoped to that tenant's data only
✓ Metabase row filter on `tenant_id` is applied server-side via signed JWT payload
✓ Isolation test: signed token for Tenant A cannot be replayed to view Tenant B's dashboard

R19: Per-user performance dashboard shows individual metrics
✓ Dashboard filtered to `assigned_to = currentUserId` — shows assigned records, completed transitions, SLA adherence
✓ Token includes `user_id` filter; UI auto-refreshes token before 10-min TTL expires (refresh at 9 min)

---

## §V Invariants

- Export rows always scoped by `tenantId` from auth — never from query params
- Saved views never leak across tenant boundaries regardless of `entityTypeId` collision
- Workflow state deletes blocked when active instances exist (`WORKFLOW_STATE_IN_USE`)
- Automation rule builder writes to `automation_rules` table only — no engine code changes
- Metabase JWT signed server-side; client never holds the signing secret
- All new tables have `tenant_id NOT NULL`, RLS policy, and `tenant_id` index
- Export async path must clean up temp files/S3 objects after download or after 24 h TTL

---

## §T Tasks

| id  | task                                                                           | phase | status | depends |
| --- | ------------------------------------------------------------------------------ | ----- | ------ | ------- |
| T1  | `saved_views` migration (table + RLS + indexes)                                | 1     | todo   | —       |
| T2  | Saved views CRUD API (`/saved-views`) + isolation tests                        | 1     | todo   | T1      |
| T3  | Saved views UI — selector, save modal, share toggle (admin-ui + portal)        | 1     | todo   | T2      |
| T4  | Export API — sync stream ≤ 5k rows (CSV + xlsx + PDF), async 202 path          | 1     | todo   | —       |
| T5  | Export UI — format picker button on entity list pages, async polling banner    | 1     | todo   | T4      |
| T6  | Automation rule builder UI — trigger picker, condition builder, action builder | 2     | todo   | —       |
| T7  | Rule list page — enable/disable toggle, priority drag-to-reorder               | 2     | todo   | T6      |
| T8  | Trigger/action type config registry (extensibility layer)                      | 2     | todo   | T6      |
| T9  | ReactFlow canvas — state nodes + transition edges, auto-layout (dagre)         | 3     | todo   | —       |
| T10 | Canvas edit ops — add/rename/delete state, draw/edit/delete transition         | 3     | todo   | T9      |
| T11 | Canvas save (atomic), dirty state indicator, nav-away guard                    | 3     | todo   | T10     |
| T12 | Large-workflow fallback (> 20 states → form-based editor)                      | 3     | todo   | T10     |
| T13 | Add Metabase OSS to docker-compose + seed default dashboards                   | 4     | todo   | —       |
| T14 | `/metabase/embed-token` API — signed JWT with tenant + user filters            | 4     | todo   | T13     |
| T15 | Metabase embed UI in admin-ui — tenant dashboard + per-user dashboard tab      | 4     | todo   | T14     |
| T16 | Metabase token auto-refresh (9-min interval), isolation test                   | 4     | todo   | T15     |

phase gate: all unit + integration + isolation tests pass before advancing

---

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |
| —   | —           | —          | —               |

---

_spec is source of truth — update as decisions are made_
