# Implementation Plan: Ticket Detail Live Updates

**Spec:** docs/specs/ticket-live-updates.md
**Generated:** 2026-08-11
**Status:** all phases complete

---

## Phase 1 — Event emission (outbox)

**Goal:** Every relevant domain action (plain comment, access-request create, access-request resolve) writes an outbox event, closing the gaps identified in the earlier investigation.
**Gate:** all unit tests pass → then Phase 2

| task                                                                                                                                                                                  | requirement | status                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| T1: New outbox event schemas + TriggerTypes (`comment.created`, `access_request.created`, `access_request.updated`) in `packages/automation-engine/src/event-schemas.ts`              | R1, R3, R4  | done                                                                                                |
| T2: Wire unconditional `comment.created` outbox write into `apps/api/src/routes/entities/add-comment.ts` (additive to existing mention/reply/access-grant writes)                     | R1, R5      | done                                                                                                |
| T3: Wire `access_request.created` outbox write into the request-access creation route                                                                                                 | R3          | done                                                                                                |
| T4: Verify whether `resolve-access-request.ts`'s `emitAccessEvent()` already reaches `outboxEvents`; wire `access_request.updated` outbox write (carrying resolution `status`) if not | R4          | done (confirmed `emitAccessEvent` only covers access_grant/access_revoke — added a dedicated write) |

---

## Phase 2 — Room transport (server + worker)

**Goal:** The existing WS server and notify worker gain a room-keyed fan-out path, parallel to and independent of the existing per-user notification path.
**Gate:** integration tests pass + Phase 1 gate still green

| task                                                                                                                                                                                                                                                                                                                | requirement    | status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------ |
| T5: Server room registry in `apps/api/src/websocket/notifications.ts` — `rooms: Map<string, Set<WebSocket>>` keyed `${tenantId}:${instanceId}`; handle `subscribe_ticket`/`unsubscribe_ticket` client messages with a tenant+instance read-access check before joining; remove connection from all rooms on `close` | R6, R7         | done   |
| T6: Redis message envelope gains a `kind: "room" \| "user"` discriminator; WS subscriber (`startPushSubscriber`) dispatches `kind:"room"` to `sendToRoom` and `kind:"user"` to the existing `sendToConnections`                                                                                                     | R2             | done   |
| T7: Worker (`apps/worker/src/notification-worker.ts`) publishes a room-kind message for each of the 3 new trigger types, independent of whatever recipient-resolution/notification-row logic that event also triggers                                                                                               | R2, R3, R4, R5 | done   |

---

## Phase 3 — Client integration + tests

**Goal:** The ticket detail page joins/leaves the room automatically and renders live pushes; cross-tenant and lifecycle behavior is verified.
**Gate:** §R acceptance criteria met, `pnpm test:isolation` green

| task                                                                                                                                                                                                                                                                                                           | requirement | status |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T8: Client (`apps/admin-ui/src/lib/notifications-client.ts` or an adjacent hook) sends `subscribe_ticket` on ticket detail page mount, `unsubscribe_ticket` on unmount, and re-sends `subscribe_ticket` after the existing reconnect-with-backoff fires while the page is still mounted                        | R7, R8      | done   |
| T9: UI — comment list and access-request list on the ticket detail page consume `comment.created` / `access_request.created` / `access_request.updated` messages and splice the update into the already-rendered list                                                                                          | R2, R3, R4  | done   |
| T10: Isolation/unit tests — cross-tenant room-key isolation (same `instanceId`, different `tenantId` never cross-delivers), access-check-gated subscribe (no read access → silently not joined), independence of room push vs inbox notification (R5's two scenarios), cleanup on `close`/`unsubscribe_ticket` | R1–R8       | done   |

---

## Kick-Off Prompt

Copy this into your Claude Code / AntiGravity session to start implementation:

```
Read docs/specs/ticket-live-updates.md and docs/specs/ticket-live-updates-tasks.md.

Implement Phase 1 tasks only (T1, T2, T3, T4).

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
```
