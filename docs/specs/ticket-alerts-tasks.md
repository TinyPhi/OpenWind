# Implementation Plan: Ticket Alerts

**Spec:** docs/specs/ticket-alerts.md
**Generated:** 2026-07-28
**Status:** not started

---

## Phase 1 — Data Model

**Goal:** `ticket_alerts` table exists, tenant-isolated, correctly scoped, with grants — no API/worker yet.
**Gate:** isolation tests pass → then Phase 2

| task                                                                                                                                                                                                                                                   | requirement         | status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | ------ |
| T1: Migration 0042 — `ticket_alerts` table (cols per §I), RLS (tenant-only, no per-user policy), indexes `(tenant_id, instance_id)` / `(tenant_id, created_by)`, `GRANT` to `app_user` in same migration, analytics annotation, down-migration comment | R1–R10 (foundation) | todo   |
| T2: Drizzle schema for `ticket_alerts` in `packages/db/src/schema`                                                                                                                                                                                     | R1–R10 (foundation) | todo   |
| T11: Isolation tests — cross-tenant `ticket_alerts` RLS (confirm tenant-only, not per-user)                                                                                                                                                            | R2 (RLS clause)     | todo   |

---

## Phase 2 — API Layer

**Goal:** full CRUD on alerts, with visibility/ownership/cap/access rules enforced server-side.
**Gate:** integration tests pass + Phase 1 gate still green

| task                                                                                                                                                                                                                         | requirement | status |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T3: `POST /entities/:instanceId/alerts` — access check (404 if none), 20-cap check (422), future-`fire_at` check (422), recipient snapshot (explicit access list ∪ creator) for scope='all', outbox row inserted in same txn | R1, R4      | todo   |
| T4: `GET /entities/:instanceId/alerts` — app-layer visibility filter (creator-always; scope='all' + `hasEntityReadAccess`)                                                                                                   | R2          | todo   |
| T5: `PATCH` / `DELETE /entities/:instanceId/alerts/:id` — creator-only (403 if scope='all' non-creator, 404 if scope='me' non-creator), reject on `fired`/`cancelled` (409/404), reschedule semantics on edit                | R3, R6, R9  | todo   |
| T6: New BullMQ queue `ticket-alerts` in `apps/worker/src/queues.ts`, `defaultJobOptions` matching `slaQueue`                                                                                                                 | R5 (infra)  | todo   |

---

## Phase 3 — Scheduling & Delivery

**Goal:** alerts fire exactly once, reliably, through the existing notification pipeline, independent of SLA infra.
**Gate:** §R5–R9 acceptance criteria pass (incl. simulated redis-loss recovery test) + Phase 1–2 gates still green

| task                                                                                                                                                                                                                              | requirement | status |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T7: `apps/worker/src/alert-scheduler.ts` — separate poller (10s interval) for `ticket.alert_scheduled` outbox rows, enqueues `alert:{alertId}` BullMQ job; fully independent file/queue from `sla-scheduler.ts`                   | R5          | todo   |
| T8: `apps/worker/src/alert-worker.ts` — fire-time consumer; transactional guard on `status='pending'`; writes `notifications`/`notification_recipients` + enqueues `notify-outbound`; flips to `fired`/`fired_at` only on success | R5, R7      | todo   |
| T9: Cascade-cancel hooks — ticket archive/delete cancels its pending alerts + jobs; creator's own access revocation cancels their pending alerts + jobs                                                                           | R8          | todo   |

---

## Phase 4 — UI

**Goal:** ticket-detail page exposes create/list/edit/cancel through the agreed 3-dot-menu → modal flow, matching API-enforced rules exactly.
**Gate:** §R acceptance criteria (all of R1–R10) met end-to-end

| task                                                                                                                                                | requirement | status |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T10: Admin-UI — 3-dot menu + alert modal (list + add form) on `record-detail.tsx` action row; creator-only affordances; in-place form reset on save | R10         | todo   |
| T12: Full unit/integration test sweep across R1–R10 (cross-phase, run last)                                                                         | R1–R10      | todo   |

---

## Kick-Off Prompt

```
Read docs/specs/ticket-alerts.md and docs/specs/ticket-alerts-tasks.md.

Implement Phase 1 tasks only (T1, T2, T11).

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass (pnpm test:isolation)
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B docs/specs/ticket-alerts.md to log it before fixing
- If the same bug class could recur, run: /spec amend §V docs/specs/ticket-alerts.md to make it an invariant
- Follow packages/db conventions (RLS, grants, analytics annotation) exactly as in 0028_access_requests.sql
```
