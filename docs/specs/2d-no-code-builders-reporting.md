# 2D — No-code builders + reporting

> Configuration UI + export layer on top of existing engines. No engine code changes.
> For: tenant admins (configure rules/workflows) + agents (saved views, export).

status: draft
created: 2026-06-16
updated: 2026-06-16
issue: #15
phase-gate: Phase 2 → pilot onboarding

---

## §G Goal

Pilot customer admins can configure automation rules and workflow states without touching code or SQL.
Agents can save filtered views and export entity data to CSV/Excel.
Metabase embedded reporting available on admin dashboard.

Done looks like:

- Admin creates a "notify on SLA breach" automation rule → engine fires it → verified in execution log
- Admin edits a workflow state label / SLA hours via UI → engine reads it on next transition
- Agent saves "My open tickets" filter → reloads it next session
- Agent exports all resolved tickets → downloads valid CSV with all fields
- Admin opens dashboard → sees Metabase iframe scoped to their tenant's data

---

## §C Constraints

| constraint        | value                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------- |
| stack             | Hono API (Node.js) · Drizzle/Postgres · React admin-ui (Refine + shadcn/ui)               |
| auth              | Zitadel JWT; tenant context set by RLS middleware                                         |
| engine rule       | automation_rules / workflow_states / workflow_transitions already exist — no schema drops |
| module rule       | modules are seed SQL only; all new code in `packages/*` + `apps/*`                        |
| pilot constraint  | sequential workflows only; parallel approval not in scope                                 |
| export size limit | ≤ 10 000 rows per export; stream response (no in-memory buffer)                           |
| saved_views owner | user-scoped (not tenant-wide); users cannot see each other's views                        |
| Metabase          | docker-compose only for dev/pilot; no production K8s manifest required for this track     |
| out of scope      | schedule.cron / connector.event / connector.action / script action types in builder UI    |
| out of scope      | drag-and-drop between states (visual graph editor); layout is linear pipeline             |
| out of scope      | parallel approval, branching workflows                                                    |
| out of scope      | Metabase question/dashboard authoring (read-only embed only)                              |

---

## §I Interfaces

### New table: `saved_views`

```sql
CREATE TABLE saved_views (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,          -- RLS anchor
  user_id        text NOT NULL,          -- Zitadel subject claim
  entity_type_id uuid NOT NULL REFERENCES entity_types(id) ON DELETE CASCADE,
  name           text NOT NULL,
  filter_config  jsonb NOT NULL DEFAULT '{}',
  sort_config    jsonb NOT NULL DEFAULT '{}',
  is_default     boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- analytics: included(id, tenant_id, user_id, entity_type_id, name, created_at)
```

Indexes: `(tenant_id, user_id, entity_type_id)`, `(tenant_id, entity_type_id)`.
RLS: SELECT/INSERT/UPDATE/DELETE restricted to rows where `tenant_id = current_tenant_id()` AND `user_id = current_user_id()`.

### New API routes

| method | path                                                       | auth          | purpose                                |
| ------ | ---------------------------------------------------------- | ------------- | -------------------------------------- |
| GET    | `/saved-views?entityTypeId=`                               | any role      | list user's saved views for type       |
| POST   | `/saved-views`                                             | any role      | create saved view                      |
| PATCH  | `/saved-views/:id`                                         | owner         | update name / filters                  |
| DELETE | `/saved-views/:id`                                         | owner         | delete                                 |
| GET    | `/entity-types/:id/export?format=csv\|xlsx\|pdf&[filters]` | agent / admin | export entities (sync <=5k, async >5k) |
| GET    | `/exports/:jobId/download`                                 | agent / admin | download async export job results      |
| POST   | `/reporting/embed-token`                                   | admin         | signed Metabase embed URL              |

Automation-rules CRUD API already exists at `/automation-rules` — **no new routes needed**.

### Automation rule builder — UI data contract

Builder reads existing GET `/automation-rules`, GET `/entity-types`, GET `/workflows` responses.
Builder writes existing POST/PATCH `/automation-rules`.

Supported trigger types in builder UI (subset — see §C out-of-scope):

- `workflow.entered_state` → config: `{ workflowId, state }`
- `workflow.transitioned` → config: `{ workflowId, fromState?, toState? }`
- `workflow.sla_breached` → config: `{ workflowId, state }`
- `field.changed` → config: `{ entityTypeId, field }`
- `entity.created` → config: `{ entityTypeId }`
- `entity.assigned` → config: `{ entityTypeId }`

Supported action types in builder UI (subset — see §C out-of-scope):

- `notify` → recipientId (user picker), channel[], payload template
- `set_field` → field (picker from entity type's fields), value
- `transition` → transitionId (picker from workflow transitions)
- `webhook` → url, method, headers, includePayload

Conditions: field comparisons only — `eq | neq | gt | gte | lt | lte | contains | in | empty | not_empty`. AND/OR grouping. Max depth: 3.

### Export response contract

#### Synchronous Path (≤ 5 000 rows)

Directly streams binary payload:

```
GET /entity-types/:id/export?format=csv&state=open
Content-Type: text/csv; charset=utf-8 (or application/vnd.openxmlformats-officedocument.spreadsheetml.sheet or application/pdf)
Content-Disposition: attachment; filename="<entityType>-export-<date>.csv"
```

#### Asynchronous Path (> 5 000 and ≤ 10 000 rows)

Enqueues BullMQ job and returns a job tracking ID:

```
GET /entity-types/:id/export?format=xlsx
Response (202 Accepted):
{
  "jobId": "job-async-uuid"
}
```

Client polls the download endpoint:

```
GET /exports/:jobId/download
Response (200 OK):
{
  "data": {
    "id": "job-async-uuid",
    "status": "completed",
    "downloadUrl": "https://...",
    "error": null
  }
}
```

Row order: `created_at DESC`. Columns: all non-sensitive entity fields in `sort_order`, plus `id`, `current_state`, `created_at`, `updated_at`. No field with `sensitivity = 'pii'` unless requester has explicit PII role.

### Metabase embed token contract

```
POST /reporting/embed-token
→ { iframeUrl: string, expiresAt: string }
```

Signed using `METABASE_SECRET_KEY` env var. Token payload includes `{ resource: { dashboard: N }, params: { tenant_id: tenantId } }`, expiry 10 min. Frontend renders URL in `<iframe>`.

---

## §R Requirements

### R1 — Automation rule builder: list + CRUD

R1: Admin can list, create, edit, enable/disable, and delete automation rules from admin-ui without writing JSON.
✓ `/automations` page lists all rules for tenant: name, trigger type, enabled badge, action count, priority
✓ "New Rule" wizard: step 1 = trigger picker + config form; step 2 = conditions builder (optional); step 3 = actions builder (≥1 action required); step 4 = name + priority + save
✓ Edit opens same wizard pre-populated
✓ Enable/disable toggle updates `is_enabled` immediately, rule fires / stops firing on next event
✓ Delete shows confirm modal; removes rule; engine no longer fires it
✓ If trigger type requires a workflowId, UI shows only workflows for currently-configured entity types
✓ Saving with zero actions blocked at UI and returns 400 from API
✓ Condition depth > 3 rejected with validation error

### R2 — Automation rule builder: trigger-specific config forms

R2: Each supported trigger type renders the correct config fields.
✓ `workflow.*` triggers: workflow picker (dropdown), state picker (populates from selected workflow's states)
✓ `field.changed`: entity type picker, then field picker from that entity type's fields
✓ `entity.created` / `entity.assigned`: entity type picker only
✓ State pickers show label + name; submits name value (machine key)
✓ Workflow picker filtered to tenant's active workflows

### R3 — Automation rule builder: action config forms

R3: Each supported action type renders its config form with validation.
✓ `notify`: recipient type (specific user / assigned-to), channel checkboxes (email, in-app, sms), optional payload JSON text area
✓ `set_field`: field dropdown (from entity type fields derived from trigger), value input typed to field type
✓ `transition`: transition dropdown (from workflow's transitions) — requires trigger to reference a workflow
✓ `webhook`: URL (validated as https:// only), method select, optional headers (key-value pairs), includePayload toggle
✓ Multiple actions allowed; displayed as ordered list; user can add/remove/reorder
✓ `webhook` URL that resolves to private IP rejected at API (SSRF guard already in executor — bubble error to form)

### R4 — Workflow visual editor: interactive pipeline + drag reorder

R4: Workflow detail page pipeline diagram is interactive and supports drag-to-reorder.
✓ Each state node in pipeline is clickable; opens inline edit popover (label, color, slaHours, isTerminal)
✓ State nodes are draggable left/right; releasing updates `sort_order` via PATCH `/workflows/:id/states/:stateId`
✓ Drag reorder is optimistic: UI updates immediately, rolls back on API error
✓ Transition arcs: non-adjacent transitions (fromState and toState not consecutive in sort_order) rendered with a curved/dashed arc above the pipeline
✓ Initial state node has "START" pin; terminal state nodes have "END" pin (already exists — preserve)
✓ Changes made via inline edit reflect immediately without full page reload

### R5 — Saved views: persistence and switching

R5: Users can save their current filter+sort state as a named view and reload it later.
✓ Record list pages show "Save View" button when active filter/sort differs from default
✓ Saving opens modal: name input (max 60 chars), optional "set as default" checkbox
✓ Saved views listed in a dropdown/sidebar panel on the record list page; selecting one applies its filter+sort
✓ User can rename or delete any of their own saved views
✓ Default view auto-applied on page load if user has set one for that entity type
✓ Cross-tenant: user cannot access saved views belonging to another tenant (RLS enforces this)
✓ Cross-user: user cannot access saved views belonging to another user in same tenant (user_id check in RLS)
✓ Max 20 saved views per user per entity type; 21st save returns 409 with message

### R6 — Entity export: CSV, Excel, and PDF

R6: Any entity list can be exported; download honours current filters.
✓ "Export" button on every entity list page; dropdown: CSV / Excel / PDF
✓ Export request includes same filter params as current list view (state, search, dateRange)
✓ Sync path for ≤ 5 000 rows streams response directly
✓ Async path for > 5 000 and ≤ 10 000 rows enqueues a background BullMQ job and returns `jobId` for polling
✓ CSV: UTF-8, headers row, one entity per row, fields in sort_order
✓ Excel: `.xlsx`, single sheet named after entity type plural, headers row, auto-column width
✓ PDF: layout generated utilizing worker-side PDF renderer
✓ Sensitive fields (sensitivity ≠ null) excluded unless user has pii_export role
✓ Empty result set returns valid file with headers-only row, not 404
✓ Rows > 10 000: returns 400 `EXPORT_TOO_LARGE` with message; user must apply filters first

### R7 — Metabase embed: per-tenant dashboard

R7: Admin dashboard shows a Metabase iframe scoped to the authenticated tenant.
✓ `docker-compose.yml` gains a `metabase` service on port 3030; depends on Postgres
✓ `METABASE_SECRET_KEY` and `METABASE_SITE_URL` added to `packages/config/src/env.ts` (optional — Metabase disabled if absent)
✓ POST `/reporting/embed-token` returns signed iframe URL; requires `admin` role
✓ Token expires in 10 min; frontend refreshes before expiry (polls at 9 min)
✓ Iframe URL includes `tenant_id` param so Metabase applies row filter
✓ If Metabase env vars absent, dashboard shows "Reporting not configured" placeholder
✓ Embed token endpoint rate-limited to 30 req/min per tenant

---

## §V Invariants

- Automation rule changes never alter engine code — builder only writes to `automation_rules` table
- `saved_views.user_id` = Zitadel subject of authenticated user; never writable by client
- Export never reads across tenant boundary; query always includes `tenant_id` from auth context
- SSRF guard applies to webhook action URLs at both save time (API validation) and execution time (executor)
- Metabase embed token includes tenant_id in signed payload; server verifies signature before returning URL
- `saved_views` RLS: both `tenant_id = current_tenant_id()` AND `user_id = current_user_id()` required — tenant isolation is not sufficient alone
- No PII fields in export unless requesting user has explicit `pii_export` role — checked at export time, not cached
- Workflow state drag-reorder writes `sort_order` values; engine reads `sort_order` for pipeline display only — transition routing is unaffected by sort_order

---

## §T Tasks

| id  | task                                                                                            | phase | status | depends  |
| --- | ----------------------------------------------------------------------------------------------- | ----- | ------ | -------- |
| T1  | Migration 0018: `saved_views` table + RLS + indexes + analytics comment                         | 1     | todo   | —        |
| T2  | Drizzle schema: `savedViews` table object in `packages/db`                                      | 1     | todo   | T1       |
| T3  | API routes: saved-views CRUD (`packages/db` query helpers + `apps/api` route handlers)          | 1     | todo   | T2       |
| T4  | Unit tests: saved-views routes (owner isolation, max-20 limit, default flag)                    | 1     | todo   | T3       |
| T5  | RLS isolation test: saved_views cross-tenant + cross-user blocked                               | 1     | todo   | T3       |
| T6  | Export endpoint: `GET /entity-types/:id/export` — CSV streaming (papaparse or csv-write-stream) | 1     | todo   | —        |
| T7  | Export endpoint: xlsx variant (exceljs or xlsx)                                                 | 1     | todo   | T6       |
| T8  | Export: PII field exclusion + `EXPORT_TOO_LARGE` guard                                          | 1     | todo   | T6       |
| T9  | Unit tests: export route (CSV shape, xlsx shape, PII exclusion, size guard)                     | 1     | todo   | T7, T8   |
| T10 | admin-ui: Automations list page (`/automations`)                                                | 2     | todo   | —        |
| T11 | admin-ui: Automation rule wizard — Step 1 trigger picker + config forms                         | 2     | todo   | T10      |
| T12 | admin-ui: Automation rule wizard — Step 2 conditions builder (AND/OR tree, depth ≤ 3)           | 2     | todo   | T11      |
| T13 | admin-ui: Automation rule wizard — Step 3 actions builder (multi-action list)                   | 2     | todo   | T12      |
| T14 | admin-ui: Automation rule wizard — Step 4 name + priority + save                                | 2     | todo   | T13      |
| T15 | admin-ui: enable/disable toggle + delete on automations list                                    | 2     | todo   | T14      |
| T16 | admin-ui: Workflow detail — clickable state nodes (inline edit popover)                         | 2     | todo   | —        |
| T17 | admin-ui: Workflow detail — drag-to-reorder states (HTML5 drag or @dnd-kit)                     | 2     | todo   | T16      |
| T18 | admin-ui: Workflow detail — transition arc rendering for non-adjacent transitions               | 2     | todo   | T16      |
| T19 | admin-ui: Record list — saved views UI (save button, views dropdown, default apply)             | 2     | todo   | T3       |
| T20 | admin-ui: Record list — Export button + CSV/Excel download                                      | 2     | todo   | T9       |
| T21 | portal: Record list — Export button + saved views (same as T19/T20 for portal app)              | 2     | todo   | T19, T20 |
| T22 | Metabase: add service to docker-compose, env vars to config                                     | 3     | todo   | —        |
| T23 | API: `POST /reporting/embed-token` route + rate limit                                           | 3     | todo   | T22      |
| T24 | admin-ui: Dashboard Metabase iframe panel (refresh at 9 min, graceful fallback)                 | 3     | todo   | T23      |

phase gate: all unit + isolation tests pass before advancing; T22–T24 (Metabase) are phase 3 and can ship after pilot onboarding begins

---

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |

---

## Phase 2 exit criteria mapping (from issue #15)

| criterion                                      | covered by     |
| ---------------------------------------------- | -------------- |
| Pilot submits tickets, agents manage with SLA  | 2A/2B/2C done  |
| Expense claim approval chain end-to-end        | 2B/2C done     |
| New module installable via seed config         | 2B done        |
| Notification templates editable without deploy | 2A done        |
| Export working on all entity types             | T6–T9          |
| Penetration test (tenant isolation) passed     | T5 + pre-pilot |

---

_spec is source of truth — update as decisions are made_
