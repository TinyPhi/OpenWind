# Implementation Plan: In-App Notification Hub

**Spec:** docs/specs/in-app-notification-hub.md
**Generated:** 2026-07-23
**Status:** not started

---

## Phase 1 — Data Model & Event Instrumentation

**Goal:** Every trigger type has a durable outbox event; the notification tables exist with RLS, idempotency, and de-dupe support already built in.
**Gate:** all unit tests pass, `pnpm typecheck`/`pnpm lint` clean → then Phase 2

| task                                                                                                                                                                                      | requirement | status |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T1: Migration — `notifications` + `notification_recipients` tables, RLS policies, `(tenant_id, created_at, id)` index, `unique(notification_id, user_id)`, outbound attempt-marker column | R1, R8, R16 | todo   |
| T2: New outbox event schemas + `TriggerType`s — `comment.mentioned`, `access.granted`, `access.revoked`, `system.error` (each carrying actor id)                                          | R1, R2      | todo   |
| T3: Wire outbox writes into `add-comment.ts`, `grant-access.ts`, `revoke-access.ts` (currently only write `workflow_events`, not the outbox)                                              | R1, R4      | todo   |

---

## Phase 2 — Delivery Engine

**Goal:** Outbox events become in-app notifications, delivered live over websocket, with a de-duped, retried handoff to the external service.
**Gate:** integration tests pass + Phase 1 gate still green

| task                                                                                                                                                                                             | requirement                     | status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | ------ |
| T4: Worker #1 (in-app notifier) — recipient resolution per trigger type (dynamic snapshot, self-suppression, deleted-user placeholder/skip), idempotent row writes, hardcoded template rendering | R1, R2, R3, R4, R5, R6, R7, R17 | todo   |
| T5: Websocket layer embedded in `apps/api` — JWT-authed upgrade, connection registry keyed by `(tenant_id, user_id)`, push on notify, read-state broadcast across a user's own connections       | R9, R10                         | todo   |
| T6: Worker #2 (outbound handoff) — single `dispatchOutbound` seam, attempt-marker check before calling out, 3 attempts/exponential backoff, `system.error` emission on permanent failure         | R13, R14, R16                   | todo   |
| T7: API — `GET /notifications` (keyset pagination), `POST /notifications/:id/read`, `POST /notifications/mark-all-read` (single bulk UPDATE)                                                     | R8, R11, R12                    | todo   |

---

## Phase 3 — Consumer Surface & Cleanup

**Goal:** End-to-end UI, the stub is retired, and isolation tests prove tenant safety and idempotency hold under retry.
**Gate:** §R acceptance criteria met, `pnpm test:isolation` green

| task                                                                                                                                                                                                                                 | requirement            | status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ------ |
| T8: UI — notification bell/popup (latest 10 + load more, mark-all-read, urgent styling for `system.error`, click-to-navigate + mark-read)                                                                                            | R9, R10, R11, R12, R15 | todo   |
| T9: New minimal system-logs page/API for admins (`GET /admin/system-logs`) — viewer only, not a full observability product                                                                                                           | R7                     | todo   |
| T10: Retire stub `executeNotifyAction` in `packages/automation-engine/src/actions/notify.ts`, route through this system                                                                                                              | R1                     | todo   |
| T11: Isolation tests — cross-tenant RLS on both new tables; simulated outbox redelivery (idempotency); simulated handoff-job retry (no duplicate external call); self-suppression per trigger type; deleted-actor/recipient handling | R1, R2, R16, R17       | todo   |

---

## Kick-Off Prompt

Copy this into your Claude Code / AntiGravity session to start implementation:

```
Read docs/specs/in-app-notification-hub.md and docs/specs/in-app-notification-hub-tasks.md.

Implement Phase 1 tasks only (T1, T2, T3).

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
```
