# Ticket Alerts

> Personal, schedulable reminders on a ticket — notify self or everyone with ticket access at a future date/time.

status: draft
created: 2026-07-28
updated: 2026-07-28

---

## §G Goal

User sets a one-time reminder ("alert") on a ticket w/ note + future date/time + audience
(self-only | everyone w/ ticket access). At that time, target(s) get notified via existing
in-app + outbound pipeline. Alert survives worker/redis restarts. Creator can edit/cancel
before fire; non-creators get read-only visibility into shared alerts, none into private ones.

## §C Constraints

| constraint       | value                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack            | Hono API, Drizzle/Postgres, BullMQ, apps/admin-ui (Refine+shadcn), existing outbox pattern                                                                                                                                                                                                                                                    |
| auth             | reuse `hasEntityReadAccess`/`entity-access.ts` for "who has ticket access"                                                                                                                                                                                                                                                                    |
| notif delivery   | reuse existing live pipeline as-is: `notifications`/`notification_recipients` → `notify-outbound` queue. NO changes to that pipeline.                                                                                                                                                                                                         |
| durability       | SLA-style outbox+poller, but a SEPARATE poller — do not touch `sla-scheduler.ts`                                                                                                                                                                                                                                                              |
| RLS              | tenant-only on `ticket_alerts` (no per-user policy — access filtering is app-layer)                                                                                                                                                                                                                                                           |
| out of scope     | recurrence, resend-after-fire, retention/purge, fixing `NOTIFICATION_SERVICE_URL` seam, org-wide admin/agent auto-recipients, `admin_audit_log` entries for alert create/edit/cancel/fire (personal reminders, not ticket-content mutations — explicit decision, not oversight), global cross-ticket alert cap (only per-ticket cap in scope) |
| migration number | 0042 (last existing: 0041)                                                                                                                                                                                                                                                                                                                    |
| soft cap         | 20 pending alerts / user / ticket → 422 past it                                                                                                                                                                                                                                                                                               |
| timezone         | browser-local input, stored UTC                                                                                                                                                                                                                                                                                                               |
| poll interval    | alert-scheduler.ts polls every 10s, matching sla-scheduler.ts's cadence                                                                                                                                                                                                                                                                       |

## §I Interfaces

**Table `ticket_alerts`** (tenant-scoped, follows `0028_access_requests.sql` template incl. `GRANT` in same migration):

| column                | type        | notes                                                                                                              |
| --------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| id                    | uuid pk     |                                                                                                                    |
| tenant_id             | uuid        | FK tenants, RLS predicate                                                                                          |
| instance_id           | uuid        | FK entity_instances                                                                                                |
| created_by            | text        | setter's user id                                                                                                   |
| note                  | text        |                                                                                                                    |
| fire_at               | timestamptz | UTC                                                                                                                |
| scope                 | text        | `'me' \| 'all'`                                                                                                    |
| recipients_snapshot   | jsonb       | user ids, captured at creation; `null` when scope='me'; when scope='all' = explicit ticket access list ∪ {creator} |
| status                | text        | `'pending' \| 'fired' \| 'cancelled'`                                                                              |
| fired_at              | timestamptz | null until fired                                                                                                   |
| created_at/updated_at | timestamptz |                                                                                                                    |

Indexes: `(tenant_id, instance_id)`, `(tenant_id, created_by)`.

**Outbox event**: `event_type = 'ticket.alert_scheduled'`, `payload = { alertId, fireAt }`. Written
in the same transaction as the `ticket_alerts` insert.

**BullMQ**: new queue `ticket-alerts` (same `defaultJobOptions` as `slaQueue`: `attempts:3`,
exponential backoff). Job id: `alert-{alertId}` (deterministic, enables remove/reschedule;
dash not colon — BullMQ rejects colons in custom job IDs).

**API routes** (under existing entity/ticket route namespace):

- `POST /entities/:instanceId/alerts` — create
- `GET /entities/:instanceId/alerts` — list (app-layer filtered, see R2)
- `PATCH /entities/:instanceId/alerts/:id` — edit (creator only)
- `DELETE /entities/:instanceId/alerts/:id` — cancel (creator only)

**UI**: 3-dot menu → modal on `apps/admin-ui/src/pages/customer/record-detail.tsx` action row
(~line 2710-2801). Modal = alert list (this user's visible alerts) + single-alert add form below.
"+"/save resets form in place; modal stays open for adding another.

## §R Requirements

R1: Creator can schedule a one-time alert on a ticket w/ note, future date/time, and scope —
but only if they already have access to that ticket.
✓ POST with valid future `fire_at` (local time converted to UTC) returns 201, row status='pending'
✓ POST with `fire_at` in the past returns 422
✓ POST when creator already has 20 pending alerts on that ticket returns 422
✓ POST by a requester without `hasEntityReadAccess` on the target instance returns 404 (not 403 — matches existing cross-tenant-resource convention of not leaking existence)
✓ outbox row inserted in same transaction as `ticket_alerts` insert (no orphan alert w/o outbox row)

R2: Visibility follows creator-always / scope-gated-for-others rule, enforced app-side.
✓ GET returns a row if `created_by = requester`
✓ GET returns a row if `scope='all'` AND requester ∈ ticket's explicit access list (createdBy, assignedTo, `fields.__accessUsers` keys) — computed via existing `hasEntityReadAccess` helper
✓ GET never returns a `scope='me'` row to any user other than its creator
✓ `ticket_alerts` RLS enforces tenant isolation only — no per-user RLS predicate exists

R3: Only the creator can edit or cancel an alert, regardless of scope.
✓ PATCH/DELETE by non-creator on a `scope='all'` alert returns 403 (existence already visible to them per R2, action is simply forbidden)
✓ PATCH/DELETE by non-creator on a `scope='me'` alert returns 404 (existence is not visible to them per R2 — 403 would leak that it exists)
✓ non-creator's list response omits edit/delete affordance data (or UI hides icons — enforced both sides)

R4: "Everyone with access" recipients are snapshotted at creation, not re-derived at fire time,
and always include the alert's own creator.
✓ `recipients_snapshot` populated at INSERT from ticket's explicit access list (createdBy + assignedTo + `fields.__accessUsers` keys) UNION the alert creator's own id — excludes org-wide admins/agents who only have access via role and aren't otherwise in that list
✓ a creator whose only access to the ticket is role-based (admin/agent) still appears in their own alert's `recipients_snapshot` — they are notified about their own reminder
✓ subsequent changes to the ticket's access list do not mutate an existing alert's `recipients_snapshot`

R5: Alert fires exactly once, reliably, even across worker/redis restarts, without affecting
SLA timer processing.
✓ alert scheduling/firing runs on infra fully independent of `sla-scheduler.ts`/`sla-breacher.ts` — SLA timer latency/throughput is unaffected by alert volume, verified by keeping the two pollers in separate files/queues (mechanics in §I)
✓ an alert whose outbox row is written but whose BullMQ job is lost (simulated redis flush before poll) still fires within one poll cycle after recovery — no silent loss
✓ a fired notification is written and the alert's status reflects `fired` atomically — never one without the other
✓ replaying/retrying the fire job for an already-`fired`/`cancelled` alert produces no duplicate notification and no state change

R6: Edit reschedules; cancel removes; both take effect regardless of whether the underlying
job was already enqueued.
✓ editing a pending alert's `fire_at` results in the notification firing at the NEW time, never the old one
✓ cancelling a pending alert results in no notification ever being sent for it, regardless of how close to `fire_at` the cancel happens (short of the fire transaction already having committed)
✓ a job that was already in-flight at edit/cancel time never produces a duplicate or stale-time notification (mechanics: job removal + fresh outbox row, or status-guard no-op — §I)

R7: Firing notifies the right audience through the existing pipeline, unmodified.
✓ scope='me' fire → notification recipient = creator only
✓ scope='all' fire → notification recipients = `recipients_snapshot` user ids
✓ delivery path = existing `notifications`/`notification_recipients` insert + `notify-outbound` enqueue (no new delivery mechanism)
✓ a recipient id in the snapshot that no longer resolves to a user is skipped, not an error

R8: Pending alerts are cascade-cancelled when they can no longer meaningfully fire.
✓ ticket archived/deleted → all its `pending` alerts set `cancelled`, jobs removed
✓ creator's own ticket access revoked → creator's own `pending` alerts on that ticket set `cancelled`, jobs removed

R9: Fired alerts remain as permanent, read-only history.
✓ fired alert still returned by GET (per R2 visibility) w/ `status='fired'`, `fired_at` set
✓ no PATCH/DELETE accepted on a `fired` or `cancelled` alert (idempotent 409/404)
✓ no resend action exists

R10: The ticket-detail UI surfaces alerts consistently with the API's visibility/ownership rules.
✓ a non-creator viewing a `scope='all'` alert sees no edit/cancel affordance for it (creator-only actions are absent from render, not merely disabled)
✓ the creator's own alerts (any scope) always show edit/cancel affordances while `status='pending'`
✓ fired/cancelled alerts render without edit/cancel affordances regardless of who's viewing
✓ saving a new alert clears the add-alert form in place without closing the modal, and the new alert appears in the list immediately

## §V Invariants

- `ticket_alerts.recipients_snapshot` is write-once at creation for scope='all'; never recomputed from live access data.
- Every `ticket_alerts` insert has a corresponding `outbox_events` row inserted in the same DB transaction — never one without the other (avoids the #126 bug class: entity engine event emission decoupled from the state change it describes).
- Fire-time status transition (`pending`→`fired`) and the notification write happen atomically — never notify without the flip, never flip without notifying.
- Non-creator can never mutate an alert via API, even if scope='all' — enforced in the route handler, not just hidden in UI.
- `alert-scheduler.ts` and `sla-scheduler.ts` remain independent files/pollers — do not merge or make alerts a special case inside SLA code.

## §T Tasks

| id  | task                                                                                                                           | phase | status | depends  |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ----- | ------ | -------- |
| T1  | Migration 0042: `ticket_alerts` table, RLS (tenant-only), indexes, GRANT, analytics annotation                                 | 1     | todo   | —        |
| T2  | Drizzle schema for `ticket_alerts` (packages/db/src/schema)                                                                    | 1     | todo   | T1       |
| T3  | `POST /entities/:id/alerts` — create + outbox insert (txn), 20-cap check, snapshot recipients                                  | 2     | todo   | T2       |
| T4  | `GET /entities/:id/alerts` — app-layer visibility filter via `hasEntityReadAccess`                                             | 2     | todo   | T2       |
| T5  | `PATCH`/`DELETE /entities/:id/alerts/:id` — creator-only, reschedule/cancel semantics                                          | 2     | todo   | T3       |
| T6  | New BullMQ queue `ticket-alerts` in `apps/worker/src/queues.ts`                                                                | 2     | todo   | —        |
| T7  | `apps/worker/src/alert-scheduler.ts` — poller for `ticket.alert_scheduled`, mirrors `sla-scheduler.ts` shape but separate file | 3     | todo   | T3, T6   |
| T8  | `apps/worker/src/alert-worker.ts` — fire-time consumer, idempotent guard + notify write                                        | 3     | todo   | T3, T6   |
| T9  | Cascade-cancel hooks: ticket archive/delete, access revocation                                                                 | 3     | todo   | T5       |
| T10 | Admin-UI: 3-dot menu + alert modal (list + add form) on `record-detail.tsx`, satisfying R10                                    | 4     | todo   | T3,T4,T5 |
| T11 | Isolation tests: tenant RLS on `ticket_alerts`                                                                                 | 1     | todo   | T1       |
| T12 | Unit/integration tests: R1–R10 acceptance criteria                                                                             | 2-4   | todo   | T3-T10   |

phase gate: all unit + integration tests pass before advancing to next phase

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |

---

_spec is source of truth — update as decisions are made_
