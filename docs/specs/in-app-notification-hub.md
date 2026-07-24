# In-App Notification Hub

> Live, websocket-delivered in-app notification inbox for entity/workflow events, with a single swappable seam to an external email/SMS/WhatsApp service owned by another team.

status: draft
created: 2026-07-23
updated: 2026-07-23
gh: #125

---

## §G Goal

- `automation-engine`'s `notify` action (issue #125, currently a stub that only logs) is replaced with a real in-app delivery path.
- Every user-relevant event (assignment, mention, access change, SLA breach, system error) produces a durable, per-recipient, read/unread-tracked notification row, visible live via websocket to connected sessions and persistently via inbox on next login.
- Delivery to email/SMS/WhatsApp is fully delegated to a separate, externally-owned service. OpenWind never implements channel delivery — only calls one isolated handoff function whose internals can change without touching anything upstream.
- No per-tenant customization of wording; templates are fixed, hardcoded, redeploy-to-change.

---

## §C Constraints

| constraint                  | value                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack                       | Drizzle (new tables), BullMQ (two new queues/consumers), Hono + websocket upgrade inside existing `apps/api` process, existing JWT auth                                                                                                                                                                                                                                                     |
| tenancy                     | `notifications` / `notification_recipients` are tenant-scoped tables — RLS required (ADR-001), explicit `tenant_id` filter in every query                                                                                                                                                                                                                                                   |
| delivery pattern            | Outbox pattern (ADR-002) — every trigger writes an outbox event in the same transaction as its domain mutation; no trigger calls the notifier synchronously                                                                                                                                                                                                                                 |
| websocket                   | Embedded in `apps/api`, starts with `docker compose up`, no new container/port. Single-instance for v1 — multi-instance fan-out (Redis pub/sub) explicitly deferred                                                                                                                                                                                                                         |
| idempotency                 | BullMQ is at-least-once — `notification_recipients` has a unique constraint on `(notification_id, user_id)`; retried jobs must no-op on conflict, not duplicate                                                                                                                                                                                                                             |
| templates                   | Hardcoded per trigger type inside the in-app notifier function; not configurable per tenant; content is generic (no leaked entity/comment detail — e.g. "X mentioned you in a comment", not the comment text)                                                                                                                                                                               |
| expiry                      | Notifications never auto-expire; unread stays unread until explicitly read                                                                                                                                                                                                                                                                                                                  |
| outbound contract           | Unknown/undecided as of this spec — isolated entirely behind one function (`dispatchOutbound` or equivalent); payload carries boolean channel flags (email/sms/whatsapp) decided per trigger type, default true                                                                                                                                                                             |
| outbound reliability        | 3 attempts, exponential backoff (matches existing automation-queue convention) on the handoff call only; external service owns its own queue/retry once handoff succeeds; permanent failure publishes a `system.error` outbox event, not just a log line                                                                                                                                    |
| outbound de-dupe            | Handoff attempt is marked (status column) before/around the external call; a retried job detects a prior attempt and skips re-sending rather than calling the external service twice                                                                                                                                                                                                        |
| websocket connection keying | Connection registry keys by `(tenant_id, user_id)` together, not `user_id` alone — tenant is already known from the JWT at handshake time, so this costs nothing extra and removes any dependence on "one tenant per user" continuing to hold                                                                                                                                               |
| deleted/deactivated users   | Actor info is captured at event-processing time; if the actor can no longer be resolved (deleted), template falls back to a generic placeholder (e.g. "A user") rather than failing. A deleted recipient is simply skipped — no row created for them                                                                                                                                        |
| out of scope                | External service's actual transport (webhook/queue/API) — deferred until known; multi-instance websocket fan-out; per-tenant template customization; workflow-settings-change events to workflow admins (no such event/trigger exists yet — future work); building the external delivery logic itself; system-logs page (T9) is a minimal viewer only, not a full log/observability product |
| depends on                  | Existing outbox pattern (`packages/workflow-engine`, `packages/automation-engine`), existing `entity.assigned` / `workflow.transitioned` / `workflow.sla_breached` events                                                                                                                                                                                                                   |

---

## §I Interfaces

### New DB tables

```
notifications
  id            uuid pk
  tenant_id     uuid fk -- RLS
  type          text    -- discriminator: entity.assigned | comment.mentioned | access.granted |
                        -- access.revoked | workflow.sla_breached | system.error
  title         text
  body          text
  link          text
  created_at    timestamptz

notification_recipients
  id              uuid pk
  notification_id uuid fk -> notifications
  user_id         uuid
  read_at         timestamptz null  -- null = unread; private per user, never exposed to other recipients
  unique (notification_id, user_id)
```

### New outbox event schemas (`packages/automation-engine/src/event-schemas.ts`, new `TriggerType`s)

```
comment.mentioned    { tenantId, instanceId, actorId, mentionedUserIds: string[] }
access.granted       { tenantId, instanceId, actorId, targetUserId }
access.revoked       { tenantId, instanceId, actorId, targetUserId }
system.error         { tenantId, context: Record<string, unknown>, reason: string }
```

(`entity.assigned`, `workflow.transitioned`, `workflow.sla_breached` already exist and already carry actor info — `assignedBy`, `actorId`/`triggeredBy`.)

### Worker #1 — in-app notifier (consumes outbox, all 6 trigger types)

```
resolveRecipients(triggerType, eventPayload): Promise<string[]>   // dynamic snapshot at processing time
notifyInApp(triggerType, eventPayload): Promise<void>
  // writes 1 notifications row + N notification_recipients rows (idempotent on conflict)
  // pushes {id, type, title, body, link, created_at} over websocket to each recipient's open connections
  // enqueues outbound-handoff job
```

### Worker #2 — outbound handoff (the single external seam)

```
dispatchOutbound(notificationId, payload: { email: boolean; sms: boolean; whatsapp: boolean; ...content }): Promise<void>
  // only integration point with the external service; contract TBD
  // bounded retry; on permanent failure, writes a system.error outbox event
```

### API / websocket surface

```
GET  /notifications?cursor=<created_at,id>&limit=10   -- keyset pagination, newest first
POST /notifications/:id/read                          -- marks read, broadcasts to other open tabs of same user
POST /notifications/mark-all-read                      -- single bulk UPDATE
WS   /notifications/stream                              -- JWT-authed, pushes new notification + read-state broadcasts
GET  /admin/system-logs                                 -- new, separate page/API for system.error events (admin role)
```

---

## §R Requirements

R1: Every one of the 6 trigger types (entity.assigned, comment.mentioned, access.granted, access.revoked, workflow.sla_breached, system.error) produces exactly one `notifications` row and one `notification_recipients` row per resolved recipient.
✓ Triggering each event type in a test produces the expected row(s), no more, no fewer.
✓ Retrying the same outbox event (simulated redelivery) does not create duplicate rows — unique constraint holds.

R2: The user who performed the triggering action is never a recipient of a notification about their own action.
✓ Self-triggered entity.assigned / comment.mentioned / access.granted / access.revoked produce zero rows for the actor, even if the actor would otherwise qualify (e.g. self-assignment).
✓ workflow.sla_breached and system.error have no actor-suppression concept (no human actor) — not applicable.

R3: Recipient resolution reflects who currently holds a role at the moment the event is processed — not a stale list from event creation time, and not retroactively updated after the notification is written.
✓ Changing the workflow's admin list between event creation and worker processing changes who is notified for that event, not any prior notification.
✓ A user added to a role after a notification was written never gains visibility into that older notification.

R4: `comment.mentioned` fires only for explicitly @mentioned users, regardless of any other suppression rule (except R2's self-suppression).
✓ A comment mentioning 2 of 5 thread participants produces recipient rows only for those 2.

R5: Ordinary workflow ticket-flow transitions (`workflow.transitioned`) never produce a notification to workflow admins.
✓ Triggering a normal state transition produces zero `notifications` rows tied to that trigger.

R6: `workflow.sla_breached` notifies all users currently in that workflow's admin list.
✓ Breaching an SLA on a workflow with N admins produces N recipient rows, matching the admin list at breach-processing time.

R7: `system.error` notifies all users holding the tenant-scoped `admin` role for that tenant, styled distinctly (urgent) in the UI, linking to the system-logs page.
✓ A simulated permanent outbound-handoff failure produces a `system.error` event, which produces recipient rows for exactly the tenant's admins.
✓ The notification's `type` renders with urgent styling and its `link` points to `/admin/system-logs`, not an entity page.

R8: Read/unread state is private per recipient — no API or UI surface exposes whether another recipient has read a shared notification.
✓ Querying/rendering another user's read state is not possible through any exposed endpoint.

R9: Live websocket push reaches only currently-connected sessions of the recipient; offline recipients still see the notification in their inbox on next load, with no data loss.
✓ A recipient with zero open connections still has the row in `notification_recipients`, visible via `GET /notifications` after reconnecting.
✓ A recipient with an open connection receives the push without needing to call `GET /notifications` to render title/body/link.

R10: All open tabs/connections for one user stay in sync on read-state changes.
✓ Marking a notification read in one connection updates unread state in that same user's other concurrently open connections without a manual refresh.

R11: The notification popup lists the latest 10 by default and loads the previous 10 on demand; loading more never skips or repeats a notification even if new ones arrive mid-scroll.
✓ New notifications arriving while a "load more" is in flight do not cause the next page to skip or repeat a row.

R12: "Mark all as read" completes as a single bulk operation regardless of backlog size.
✓ Marking all read for a user with a large unread backlog (e.g. 10,000 rows) executes as one statement, not one per row.

R13: The outbound handoff is the only code path that talks to the external notification service; its contract can change without modifying any trigger, worker #1, or table.
✓ Changing `dispatchOutbound`'s internals (e.g. swapping HTTP call for a queue publish) requires no change outside that function. (Verified by review, not an automated test.)

R14: A permanently failed outbound handoff (after 3 retries, exponential backoff) is never silently dropped — it surfaces as a `system.error` event.
✓ Forcing the handoff call to fail past its retry budget produces exactly one `system.error` outbox event with the originating `notificationId` and a reason.

R16: A retried outbound-handoff job never re-sends to the external service if a prior attempt already went out.
✓ Simulating a job retry after a successful-but-uncommitted handoff attempt results in exactly one external call, not two.

R17: A deleted/deactivated actor does not prevent a notification from being created; a deleted recipient does not receive a row.
✓ An event whose actor was deleted before processing still produces a notification, with a placeholder in place of the actor's name.
✓ An event whose resolved recipient was deleted before processing produces no row for that recipient.

R15: Clicking a notification marks it read and navigates to its `link`; this works even if the underlying resource is no longer accessible to the user (e.g. access since revoked).
✓ Clicking an access-revoked notification navigates to the ticket URL; existing access-lock-on-load behavior handles the block, no special-case notification logic required.

---

## §V Invariants

- A `notifications` row is never created without at least one corresponding `notification_recipients` row (no orphan content-only rows).
- `read_at` is only ever written by the owning `user_id`'s own recipient row — never cross-user.
- No trigger ever calls the in-app notifier or the outbound handoff synchronously/in-process; both are reached only via outbox + worker.
- `dispatchOutbound` is the only function anywhere in the codebase that constructs a request to the external notification service.
- Template strings never interpolate raw free-text user content (comment bodies, etc.) into `title`/`body` — only identifiers/names.
- RLS on `notifications` and `notification_recipients` is enforced identically to every other tenant-scoped table (ADR-001) — no exceptions for system.error rows.
- Every websocket push and connection lookup is keyed by `(tenant_id, user_id)` together, never `user_id` alone.
- The outbound handoff records an attempt marker before/around the external call; a retry checks this marker and never calls the external service twice for the same notification.

---

## §T Tasks

| id  | task                                                                                                                                                                                                    | phase | status | depends    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ---------- |
| T1  | Migration: `notifications` + `notification_recipients` tables, RLS policies, indexes (incl. keyset pagination index on `(tenant_id, created_at, id)`), outbound attempt-marker column for de-dupe (R16) | 1     | todo   | —          |
| T2  | New outbox event schemas + TriggerTypes: `comment.mentioned`, `access.granted`, `access.revoked`, `system.error`                                                                                        | 1     | todo   | —          |
| T3  | Wire outbox writes into `add-comment.ts`, `grant-access.ts`, `revoke-access.ts` (currently only write `workflow_events`)                                                                                | 1     | todo   | T2         |
| T4  | Worker #1: in-app notifier — recipient resolution per trigger type, idempotent row writes, template rendering                                                                                           | 2     | todo   | T1, T2, T3 |
| T5  | Websocket layer embedded in `apps/api`: JWT-authed upgrade, per-user connection tracking, push on notify, read-state broadcast across a user's connections                                              | 2     | todo   | T4         |
| T6  | Worker #2: outbound handoff — single `dispatchOutbound` seam, bounded retry, `system.error` emission on permanent failure                                                                               | 2     | todo   | T4         |
| T7  | API: `GET /notifications` (cursor pagination), `POST /notifications/:id/read`, `POST /notifications/mark-all-read`                                                                                      | 2     | todo   | T4         |
| T8  | UI: notification bell/popup (latest 10 + load more, mark-all-read, urgent styling for system.error, click-to-navigate)                                                                                  | 3     | todo   | T5, T7     |
| T9  | New system-logs page/API for admins (`GET /admin/system-logs`)                                                                                                                                          | 3     | todo   | T6         |
| T10 | Retire/replace stub `executeNotifyAction` in `packages/automation-engine/src/actions/notify.ts` to route through this system                                                                            | 3     | todo   | T4         |
| T11 | Isolation tests: cross-tenant RLS on both new tables; idempotency test (simulated redelivery); self-suppression test per trigger type                                                                   | 3     | todo   | T1–T10     |

phase gate: all unit + integration tests pass before advancing to next phase; phase 3 additionally requires `pnpm test:isolation` green (new tenant-scoped tables).

---

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |

---

_spec is source of truth — update as decisions are made_
