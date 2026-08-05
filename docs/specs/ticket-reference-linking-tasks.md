# Implementation Plan: Ticket-to-Ticket Reference Linking

**Spec:** docs/specs/ticket-reference-linking.md
**Generated:** 2026-08-04
**Status:** Phase 1 + Phase 2 complete, verified (unit + route + isolation tests pass against real Postgres/RLS); Phase 3 (admin-ui) next

---

## Phase 1 — Core Domain

**Goal:** `createReferenceLink` engine function enforces self-link/duplicate/access-neutral rules and inserts the mirrored relation pair atomically, with new error codes wired up.
**Gate:** all unit tests pass → then Phase 2

| task                                                                                                                                                                                                                                                                                                                                                                                                                    | requirement    | status |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------ |
| T1: Add `RELATION_REFERENCES`/`RELATION_REFERENCED_BY` constants + `createReferenceLink(db, tenantId, { fromInstanceId, toInstanceId })` in `packages/entity-engine/src/entity-relations.ts` — validates both instances exist/tenant-scoped/not-deleted (reuse pattern from `createRelation`), rejects self-link, rejects duplicate active pair, inserts mirrored pair in one transaction, no workflow/depth/cap checks | R1, R3, R4, R6 | done   |
| T2: Add `RELATION_SELF_LINK` / `RELATION_ALREADY_EXISTS` to `EntityError` codes + map to HTTP in `apps/api/src/lib/handle-entity-error.ts`                                                                                                                                                                                                                                                                              | R3, R4         | done   |
| T3: Unit tests for `createReferenceLink` — cross-entity-type pair, self-link rejected, duplicate rejected, dup-check doesn't block other pairs, soft-deleted-target link still queryable via existing `listRelations`                                                                                                                                                                                                   | R1, R3, R4, R7 | done   |

---

## Phase 2 — API Layer

**Goal:** Routes expose create/delete with the correct dual-access-required / single-access-required checks, returning 404 (never 403) on access failure.
**Gate:** integration + isolation tests pass + Phase 1 gate still green

| task                                                                                                                                                                                                                                                                                 | requirement    | status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | ------ |
| T4: `POST /entities/:id/references` route — `requireAuth()`, loads both instances, requires `hasEntityAccess` true on **both** `:id` and `toInstanceId`, else 404; calls `createReferenceLink`; 201 with relation pair                                                               | R1, R2, R6     | done   |
| T5: `DELETE /entities/:id/references/:relationId` route — `requireAuth()`, loads relation row (tenant-scoped), requires `hasEntityAccess` true on the `:id` side only, soft-deletes both mirrored rows via existing `deleteRelation` (extend if needed to delete the paired row too) | R5, R6         | done   |
| T6: Route-level tests — access required on both sides for create (missing on either → 404), unilateral delete succeeds with access to only one side, self-link/duplicate surfaced as 4xx via T2's error mapping                                                                      | R2, R3, R4, R5 | done   |
| T7: Isolation tests (`apps/api/tests/isolation/`, following `child-ticket-routes.isolation.test.ts`) — cross-tenant create blocked (404), cross-tenant delete blocked (404), no automation/outbox event emitted on create/delete                                                     | R2, R6         | done   |

---

## Phase 3 — Consumer Integration (admin-ui)

**Goal:** Ticket detail page shows a "Linked tickets" section, lets the user search-and-link within their own accessible tickets, and unlink either direction.
**Gate:** §R acceptance criteria met end-to-end (manual verification in browser per CLAUDE.md UI-change rule)

| task                                                                                                                                                                                                                                                                                                       | requirement | status |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T8: "Linked tickets" section in `apps/admin-ui/src/pages/customer/record-detail.tsx` — lists `references`/`referenced_by` via existing `GET .../relations?relationType=references&direction=both`, shows target title/workflow/state, renders soft-deleted targets as grayed-out "Linked ticket (deleted)" | R7          | todo   |
| T9: "Link ticket" search/select modal — search scoped to caller's own accessible tickets (reuse existing "my tickets" access-scoped query/component), calls `POST /entities/:id/references` on select, surfaces self-link/duplicate/403↦404 errors inline                                                  | R1, R8      | todo   |
| T10: Unlink action (icon + confirm dialog) per linked item, calls `DELETE /entities/:id/references/:relationId`, refreshes list                                                                                                                                                                            | R5          | todo   |

---

## Kick-Off Prompt

Copy this into your Claude Code / AntiGravity session to start implementation:

```
Read docs/specs/ticket-reference-linking.md and docs/specs/ticket-reference-linking-tasks.md.

Implement Phase 1 tasks only (T1, T2, T3).

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
```
