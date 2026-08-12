# Ticket Detail Live Updates

> Live, websocket-delivered updates for the comment section and access-request section of the ticket detail page — every open viewer sees new comments and access-request changes without reloading, on top of the existing #125 in-app notification pipeline.

status: implemented
created: 2026-08-11
updated: 2026-08-11
gh: —

---

## §G Goal

- Any user with a ticket's detail page open sees new comments and access-request create/resolve events appear live, with no page reload — regardless of whether that user is a notification recipient (mentioned/assigned/requester) for that event.
- Users not currently viewing the ticket still get the event in their notification inbox (existing #125 path), unchanged.
- No new WebSocket gateway, server process, or client transport — extends the existing `/ws/notifications` connection and `NOTIFICATION_PUSH_CHANNEL` Redis pub/sub already shipped in #125.

---

## §C Constraints

| constraint      | value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack           | Existing WS server (`apps/api/src/websocket/notifications.ts`), existing Redis pub/sub channel, existing BullMQ notify worker (`apps/worker/src/notification-worker.ts`), existing outbox pattern (ADR-002)                                                                                                                                                                                                                                                                                                             |
| transport reuse | One WS connection per browser tab (already established for the notification inbox) carries both inbox pushes and ticket-room pushes — no second socket                                                                                                                                                                                                                                                                                                                                                                  |
| room membership | Client-driven: page mount sends `{type:"subscribe_ticket", instanceId}`, unmount sends `{type:"unsubscribe_ticket", instanceId}`. Server holds room membership in-process per connection; not persisted                                                                                                                                                                                                                                                                                                                 |
| room scope      | One room per entity instance (ticket), not per tenant/workflow — keyed `${tenantId}:${instanceId}` to match existing tenant-scoping discipline (ADR-001)                                                                                                                                                                                                                                                                                                                                                                |
| fan-out         | Same Redis pub/sub channel (`NOTIFICATION_PUSH_CHANNEL`) carries the new room-scoped message alongside existing per-user notification messages; every API process instance's WS layer still receives every published message and filters locally (matches current single-channel, filter-on-receive design — no new channel)                                                                                                                                                                                            |
| dual delivery   | A comment-create / access-request event both (a) writes the existing #125 outbox → notification → inbox row for resolved recipients, and (b) publishes a room-scoped live-update message for current viewers. These are two independent effects of one outbox event — an event with zero notification recipients can still produce a room push, and vice versa                                                                                                                                                          |
| payload content | Room push payload mirrors the same "no raw free-text interpolation into anything persisted" discipline as #125's §V — but the _room_ payload's purpose is to hand the client enough to render the new comment/access-request row, so unlike the inbox `title`/`body`, it MAY carry the entity fields the ticket page already fetches over REST (comment body, author, access-request status) since it goes only to already-authorized viewers of that instance, never persisted, never rendered outside the ticket page |
| authorization   | Server validates tenant + instance access (existing per-entity RLS-backed check) before adding a connection to a room on `subscribe_ticket` — a user cannot join a room for a ticket they can't read                                                                                                                                                                                                                                                                                                                    |
| reconnect       | On the client's existing reconnect-with-backoff (`notifications-client.ts`), any currently-open ticket page re-sends `subscribe_ticket` — room membership is not restored server-side across a dropped connection                                                                                                                                                                                                                                                                                                       |
| out of scope    | Multi-instance Redis fan-out semantics beyond what #125 already established (still single-channel, filter-on-receive); presence indicators ("N people viewing"); typing indicators; comment edit/delete live sync (only create, per this spec's R-list); offline queueing of room events (page reload always re-fetches current state via existing REST load)                                                                                                                                                           |
| depends on      | #125 in-app notification hub (shipped, PR #211) — `apps/api/src/websocket/notifications.ts`, `apps/worker/src/notification-worker.ts`, `NOTIFICATION_PUSH_CHANNEL`, `apps/admin-ui/src/lib/notifications-client.ts`                                                                                                                                                                                                                                                                                                     |

---

## §I Interfaces

### WS message union — additions to existing client/server message types

```
Client -> Server (new):
  { type: "subscribe_ticket", instanceId: string }
  { type: "unsubscribe_ticket", instanceId: string }

Server -> Client (new):
  { type: "comment.created", instanceId, comment: { id, body, authorId, authorName, createdAt } }
  { type: "access_request.created", instanceId, request: { id, requestedBy, status, createdAt } }
  { type: "access_request.updated", instanceId, request: { id, status, resolvedBy, resolvedAt } }

Existing (unchanged):
  { type: "notification", notification }
  { type: "read", notificationIds }
```

### Server-side room registry (`apps/api/src/websocket/notifications.ts`)

```
rooms: Map<string, Set<WebSocket>>   // key: `${tenantId}:${instanceId}`
// parallel to existing `connections: Map<string, Set<WebSocket>>` keyed by `${tenantId}:${userId}`
// one WebSocket may be in zero or more rooms; room membership is cleaned up on `close`/`unsubscribe_ticket`

sendToRoom(tenantId: string, instanceId: string, message): void
```

### Outbox event schemas (`packages/automation-engine/src/event-schemas.ts`, new `TriggerType`s)

```
comment.created           { tenantId, instanceId, actorId, commentId }
access_request.created    { tenantId, instanceId, actorId, requestId }
access_request.updated    { tenantId, instanceId, actorId, requestId, status }
```

### Worker changes (`apps/worker/src/notification-worker.ts`)

```
// existing per-event handling adds, per applicable trigger type:
publishRoomUpdate(tenantId, instanceId, message): void
  // redis.publish(NOTIFICATION_PUSH_CHANNEL, { kind: "room", tenantId, instanceId, message })
  // existing per-user push becomes { kind: "user", tenantId, userId, notification }
  // WS layer's subscriber dispatches on `kind` to sendToRoom or sendToConnections
```

### Route changes

```
apps/api/src/routes/entities/add-comment.ts
  -- currently: outbox write only when mention/reply/access-grant present
  -- add: unconditional comment.created outbox write (in addition to existing conditional ones)

apps/api/src/routes/.../request-access.ts
  -- currently: no outbox write
  -- add: access_request.created outbox write

apps/api/src/routes/.../resolve-access-request.ts
  -- currently: emitAccessEvent() — verify whether this already reaches outboxEvents;
     if not, add access_request.updated outbox write alongside/inside emitAccessEvent()
```

---

## §R Requirements

R1: Posting any comment on a ticket (mentioned or not) produces a `comment.created` outbox event.
✓ Posting a comment with no @mentions still produces exactly one `comment.created` outbox row, in addition to whatever existing mention/reply outbox rows apply.

R2: Every WebSocket connection currently subscribed to a ticket's room receives a `comment.created` push within the same request cycle the worker processes the event — independent of whether the poster or viewer is a notification recipient.
✓ Two browser sessions (user A posts, user B has the ticket page open, is not mentioned/assigned) — B's page shows the new comment live without reload.
✓ A third session with the ticket page open in a different tenant never receives the push, even if given the same `instanceId` (tenant-scoped room key).

R3: Creating an access request produces an `access_request.created` outbox event and a room push to all current viewers of that ticket.
✓ Requesting access on a ticket with an open viewer session produces a visible live update to the request list on that viewer's page.

R4: Resolving an access request (approve or reject) produces an `access_request.updated` outbox event carrying the new status, and a room push to all current viewers.
✓ Approving a pending request updates status live on any open viewer's page without reload; the pushed payload's `status` matches the resolution outcome.

R5: Room-scoped pushes and per-user inbox notifications are independent — an event can produce one, both, or neither kind of downstream effect depending on existing recipient-resolution rules.
✓ A plain non-mention comment produces a room push to viewers but zero `notification_recipients` rows (matches existing #125 R4 mention-only rule).
✓ A comment mentioning a user who is not currently viewing the ticket still produces their existing inbox notification, with or without any active room viewers.

R6: A user can only join a ticket's room if they currently have read access to that entity instance.
✓ `subscribe_ticket` for an instance the user's role/tenant cannot read is rejected (no error leak — silently not added to the room, matching the platform's "404 not 403" cross-tenant convention rather than confirming the instance's existence).

R7: Leaving the ticket detail page (route unmount) or closing the tab removes the connection from the room; no further room pushes are delivered to it.
✓ Navigating away sends `unsubscribe_ticket`; a subsequent event on that ticket produces no push to that (now former) connection.
✓ A hard tab close (no unmount event fires) is cleaned up via the existing WS `close` handler removing the connection from all its rooms.

R8: Reconnection after a dropped WebSocket does not silently leave a still-open ticket page without live updates.
✓ Simulating a reconnect while the ticket detail page remains mounted results in a fresh `subscribe_ticket` message and resumed live pushes, without a manual page reload.

---

## §V Invariants

- Every room push is keyed by `${tenantId}:${instanceId}` together — never `instanceId` alone (mirrors #125's `(tenant_id, user_id)` connection-keying invariant, same cross-tenant leak risk).
- `subscribe_ticket` never adds a connection to a room without an access check against that tenant + instance succeeding first.
- Room push payloads are never persisted to any table — they are transient, re-derivable from the same REST data the page already loads on mount/reload.
- A room-scoped outbox event's existence never implies a `notifications`/`notification_recipients` row was written, and vice versa — the two delivery paths share the source event but resolve independently.
- No trigger calls the WS layer or Redis publish synchronously/in-process — room pushes reach the client only via outbox → worker → Redis, same as #125's existing invariant for inbox pushes.

---

## §T Tasks

| id  | task                                                                                                                                                                         | phase | status | depends |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1  | New outbox event schemas + TriggerTypes: `comment.created`, `access_request.created`, `access_request.updated`                                                               | 1     | done   | —       |
| T2  | Wire unconditional `comment.created` outbox write into `add-comment.ts` (additive to existing conditional writes)                                                            | 1     | done   | T1      |
| T3  | Wire `access_request.created` outbox write into request-access creation route                                                                                                | 1     | done   | T1      |
| T4  | Verify whether `resolve-access-request.ts`'s `emitAccessEvent()` reaches the outbox; wire `access_request.updated` outbox write if not                                       | 1     | done   | T1      |
| T5  | Server: room registry (`rooms` map) in `apps/api/src/websocket/notifications.ts`; handle `subscribe_ticket`/`unsubscribe_ticket` with access check; clean up on `close`      | 2     | done   | —       |
| T6  | Redis message envelope: add `kind: "room" \| "user"` discriminator; worker publishes room-kind messages for T2–T4's events; WS subscriber dispatches by kind                 | 2     | done   | T1, T5  |
| T7  | Worker: extend `notification-worker.ts` to call `publishRoomUpdate` for the 3 new trigger types, independent of existing recipient-resolution/notification-row logic         | 2     | done   | T1, T6  |
| T8  | Client: `notifications-client.ts` (or a new adjacent hook) sends `subscribe_ticket` on ticket detail page mount, `unsubscribe_ticket` on unmount, re-subscribes on reconnect | 3     | done   | T5      |
| T9  | UI: comment list and access-request list on ticket detail page consume the new message types and splice in the update live                                                   | 3     | done   | T8      |
| T10 | Isolation/unit tests: cross-tenant room key isolation, access-check-gated subscribe, independence of room push vs inbox notification, cleanup-on-close/unsubscribe           | 3     | done   | T1–T9   |

phase gate: all unit + integration tests pass before advancing to next phase; phase 3 additionally requires `pnpm test:isolation` green (room-key tenant isolation is a new cross-tenant-leak surface).

---

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |

---

_spec is source of truth — update as decisions are made_
