# Third-Party API Phase E — Status Transitions

> Let a third-party app move a ticket through its workflow, under the exact same rules a human gets — never looser.

status: draft
created: 2026-08-25
updated: 2026-08-25 (spec-review fixes: 409 response, race-condition invariant, exactly-once outbox assertion, boundary test moved to phase 1)

---

## §G Goal

`POST /api/v1/tickets/:id/transitions` exists, dual-identity auth'd (app + acting person), reuses the
platform's own transition-validation engine unmodified, and enforces a strictly narrower access
gate than every other third-party endpoint: creator / assignee / workflow-admin only — a
mentioned/granted identity, even at read_write tier, is rejected. Every attempt (success or
denial) is logged with app+person attribution.

## §C Constraints

| constraint   | value                                                                                                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack        | Hono route in `apps/api/src/routes/third-party/`, `@platform/workflow-engine`'s `executeTransition` (unmodified — no parallel/shortcut validation path)                                                                                           |
| auth         | `requireAuth(db)` + `requireActingPerson()` + a scope check (`entity:ticket:transition`, following the existing per-route scope pattern), same as every other third-party route                                                                   |
| access gate  | creator OR assignee OR workflow-admin ONLY. `__accessUsers` grants (any tier, incl. read_write) never qualify — resolved 2026-08-14 as an intentional design boundary, not a gap. Identical rule for human-UI and API callers.                    |
| out of scope | building a new/parallel transition-validation engine; changing what states/transitions a workflow allows; Access Logs screen itself (Phase F — this phase only needs to log allowed _and denied_ attempts somewhere queryable, screen ships in F) |
| depends on   | Phase B (ticket create/read — done, PR #466/#465), reuses `apps/api/src/routes/entities/execute-transition.ts`'s engine call shape                                                                                                                |

## §I Interfaces

```
POST /api/v1/tickets/:id/transitions
body: { transitionId: uuid, comment?: string, idempotencyKey?: string, metadata?: object }
201 -> { data: <workflow event> }        (same shape executeTransition already returns)
404 -> NOT_FOUND                          (nonexistent / cross-tenant / access-denied — no distinguishable body)
409 -> TRANSITION_LOCKED                  (engine's existing pessimistic-lock retry response, inherited unmodified — see workflow-engine.md)
409 -> TRANSITION_NOT_AVAILABLE           (invalid/skip-ahead transition — engine's existing error, identical to human UI; corrected from an earlier draft's incorrect 422)
403 -> scope-missing (same convention as every other third-party route)
```

No new DB table. Reuses `workflow_events` (transition history, already the ticket-timeline sink)
and `admin_audit_log` (every attempt, allowed or denied — the interim sink until Phase F's screen
exists, matching Phase C's own `tag.*` precedent).

## §R Requirements

R1: The endpoint accepts only a `transitionId` a human caller with equivalent access could also
execute — no separate/looser check.
✓ A creator/assignee/workflow-admin third-party caller successfully executes a transition that is
in the workflow's actual next-valid-state set for the ticket's current state.
✓ A transition NOT in that valid set (skip-ahead or sideways) is rejected with the identical error
`executeTransition` already returns for a human caller attempting the same invalid move — verified
by asserting the API and UI paths hit the exact same engine function with no extra branching.

R2: Access is restricted to creator, assignee, or workflow-admin — never a merely granted/mentioned
identity, regardless of that grant's read/write tier.
✓ A person holding a `read_write` `__accessUsers` grant on the ticket (but not creator/assignee/
workflow-admin) is rejected on every transition attempt — 404, same body as a nonexistent ticket.
✓ A person who is workflow-admin (per the existing `isWorkflowAdmin` check) but has no
`__accessUsers` entry at all still succeeds.

R3: Every transition attempt — success or denial — is attributable to both the calling application
and the acting person.
✓ A successful transition's `workflow_events` row carries `triggeredBy: "api"` (the canonical
`workflow_events.triggered_by` vocabulary value, distinct from `actorType`'s `"api_key"`) and the
acting person's ID in metadata, same pattern as Phase C's comment-post route.
✓ Every attempt (allowed or denied) writes an `admin_audit_log` entry with `actorType: "api_key"`,
`actingPersonId`, and an action distinguishing allowed vs. denied (e.g. `transition.executed` /
`transition.access_denied`).

R4: Automations tied to the transition fire identically whether triggered via this endpoint or the
human UI.
✓ An SLA timer cancel/reschedule and a notification rule bound to the target state both fire for
an API-driven transition, verified against the same outbox-event path `executeTransition` already
writes for human-triggered transitions (no new/duplicate outbox write introduced by this route).
✓ Exactly one `workflow.transitioned`-shaped outbox row is written per successful transition — not
zero, not two — asserted directly (not just "no _new_ write introduced"), closing the gap where an
under-specified "don't duplicate" criterion could pass even if the route accidentally suppressed
the write entirely.

R5: Cross-tenant and nonexistent ticket IDs are indistinguishable from an access-denied one.
✓ A transition request against a different tenant's ticket ID returns the identical 404 body as an
access-denied request on an existing same-tenant ticket.

## §V Invariants

- Third-party transition access is STRICTLY narrower than `hasEntityAccess`/`hasEntityCommentAccessFull`
  (both of which treat any `__accessUsers` level as sufficient) — this route needs its own check
  (creator OR assignedTo OR `isWorkflowAdmin`, explicitly never consulting `__accessUsers`). Do not
  reach for the existing `hasEntity*Access` helpers here; using them would silently reopen the
  exact boundary this phase exists to enforce.
- `executeTransition` itself must never be modified to add an API-specific bypass or shortcut —
  any third-party-specific rule lives in the route layer, before the engine call, never inside it.
- Every deny path returns the byte-identical 404 body (`{error: "NOT_FOUND", message: "Record not
found"}`) regardless of cause (nonexistent, cross-tenant, granted-but-not-owner, no access at
  all) — the platform's standing 404-not-403 convention (security.md), applies here with one more
  cause (granted-only) than prior third-party routes had to cover.
- The new T1 access-check helper calls `getWorkflow`/`isWorkflowAdmin`, which can throw
  `WORKFLOW_NOT_FOUND` if the workflow is deleted between the instance fetch and this call — the
  same race (#184) already closed on the comment-post and attachment routes via a try/catch
  folding the error into the identical 404. This has recurred on every third-party route that
  reaches `isWorkflowAdmin` so far; T2's route implementation MUST wrap the T1 check the same way
  from the first commit, not as a follow-up review fix.

## §T Tasks

| id  | task                                                                                                                                                                                                                                                                                                         | phase | status | depends |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ------ | ------- |
| T1  | New narrow access-check helper (creator/assignee/workflow-admin only, no `__accessUsers`) — likely `packages/workflow-engine` alongside `hasEntityAccess`, since it needs the same `getWorkflow`/`isWorkflowAdmin` dependency                                                                                | 1     | todo   | —       |
| T2  | `POST /api/v1/tickets/:id/transitions` route: auth+scope, fetch instance (tenant-filtered, soft-delete-excluded), T1 check, call `executeTransition` unmodified, map engine errors through the existing 404/422 conventions                                                                                  | 1     | todo   | T1      |
| T3  | `admin_audit_log` allowed/denied logging on every attempt (not just success) — extend `AuditAction` union + CHECK constraint in the same commit (self-imposed rule from the Phase C B1 incident)                                                                                                             | 1     | todo   | T2      |
| T4a | Isolation test: granted-read_write-but-not-owner rejection (404) — the single most safety-critical case in this spec, kept in phase 1 rather than deferred, so the boundary this phase exists to enforce is proven before anything else lands                                                                | 1     | todo   | T2, T3  |
| T4b | Remaining isolation tests: valid-transition success (creator/assignee/admin, 3 separate cases), invalid/skip-ahead rejection (422, same body as human UI), cross-tenant/nonexistent 404 parity, exactly-one-outbox-row assertion, SLA/notification automation fires, workflow-deleted-mid-request 404 parity | 2     | todo   | T4a     |
| T5  | `/security-review` — STRIDE on the new access-check boundary specifically (can a granted identity escalate via any path this phase adds?), tenant isolation, `/review`, docs marker, commit procedure, PR                                                                                                    | 2     | todo   | T4b     |

phase gate: all unit + isolation tests pass, `/security-review` clean, before PR opens

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |
| —   | —           | —          | —               |

---

_spec is source of truth — update as decisions are made_
