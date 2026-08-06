# Implementation Plan: Open Workflow Visibility & Ticket Creation to All Tenant Users

**Spec:** docs/specs/workflow-open-ticket-creation.md
**Generated:** 2026-07-31
**Status:** implemented (2026-07-31) — T1–T5 all complete, not yet committed

---

## Phase 1 — Backend authorization & filtering changes

**Goal:** Every non-UI code path that gates this feature (workflow resolution, assignee
validation, records-list filter) is fixed and unit-tested in the same commit as the fix,
per the repo convention (tests never trail implementation).
**Gate:** all unit tests pass (`pnpm typecheck && pnpm lint && pnpm test` scoped to touched
packages) → then Phase 2

| task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | requirement | status |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T1: Adjust workflow resolution (`packages/workflow-engine/src/workflow-crud.ts` — `listWorkflowsSummary` or a new resolver, per §I.1 options a/b) so an `entityTypeId`-scoped lookup isn't ownership-filtered for `role="user"` callers. Grep every caller of the function actually changed to confirm none relied on ownership-filtering for a different purpose. **Do not touch `getWorkflowByEntityTypeId`.**                                                                                                                                                                                                                                                                                                                                                                                                                             | R1          | done   |
| T2: Add `assignedTo` tenant-membership + `role="user"` validation to `POST /entities` (`apps/api/src/routes/entities/create.ts`) — reuse the same membership/role-filter logic `GET /platform/users` already applies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | R3          | done   |
| T3: Fix `GET /entities` list filtering — **two-file change**: (a) `packages/entity-engine/src/types.ts` + `engine.ts` (~L868) add a `scopeToUserId` field to `ListEntitiesInput` producing `createdBy = X OR assignedTo = X OR __accessUsers ? X`; (b) `apps/api/src/routes/entities/list.ts:64-81` — replace the non-privileged path's `assignedTo: userId` collapse with `scopeToUserId: userId`, leaving the privileged path's `rest.assignedTo` passthrough untouched. Reuse `my-tickets.ts:65-69`'s existing three-way OR rather than re-deriving it. Preserve the existing "query param cannot override scope" property bit-for-bit — the new scoping value must never be sourced from `rest.assignedTo` or any other query param for a non-privileged caller. Run `EXPLAIN` to confirm no sequential-scan regression on the new `OR`. | R5          | done   |

---

## Phase 2 — Cross-cutting regression & integration pass

**Goal:** Confirm the three Phase 1 changes compose correctly and nothing gated elsewhere
(workflow settings, the management list, ticket creation's existing defaults) got loosened
as a side effect.
**Gate:** integration + isolation tests pass + Phase 1 gate still green → then Phase 3

| task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | requirement    | status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------ |
| T4: Integration/isolation pass across T1–T3: confirm `PATCH`/`DELETE /admin/workflows/:id` still 404 for a non-owner `role="user"` caller (R4); confirm ticket creation still defaults `createdBy` to caller (R2 regression); confirm a non-privileged caller passing `?assignedTo=<other-user>` on `GET /entities` still cannot see another user's tickets (R5's query-param-bypass regression); run the full R1–R5 acceptance-criteria matrix, including the empty-workflow-array case and the `getWorkflowByEntityTypeId`-untouched regression test (both its field-access AND list-privilege call sites). | R1, R2, R4, R5 | done   |

---

## Phase 3 — Security review

**Goal:** Independent adversarial pass on the new surface (any tenant user can now trigger
workflow entry + assign to arbitrary `role="user"` org members) before this ships.
**Gate:** §R acceptance criteria met + `/security-review` clean or findings triaged

**T5 evidence (2026-08-05, PR #337 review round 2):** T5 had been marked "done" with no actual
review run. Ran a scoped review against the real diff (`git diff upstream/main` for this branch,
17 files) after the round-2 review also caught a real regression: `apps/api/src/routes/workflows/get.ts`
had accidentally dropped the three-layer authorization check (`isWorkflowAdmin` / `?entityId=`
proof / owns-any-ticket-in-workflow) that a prior review round (commit `dc2bb0c`, "H2") had put in
specifically to stop any `role="user"` caller browsing any workflow's full definition by id — a
real elevation-of-privilege regression, not part of this spec's scope. **Fixed: reverted
`get.ts`/`get.test.ts` to `upstream/main`'s version**, restoring the original check. Verified
`record-create.tsx` (the only ticket-creation-discovery caller) never calls `GET /workflows/:id` —
it only ever uses the list endpoint (`GET /workflows?entityTypeId=X`) — so this revert doesn't
reintroduce the "user can't discover a workflow to create their first ticket in it" bug T1 fixed.

Remaining STRIDE checks against the actual diff (`apps/api/src/routes/entities/create.ts`,
`list.ts`, `packages/entity-engine/src/engine.ts`/`types.ts`, `packages/workflow-engine/src/workflow-crud.ts`):

- **Spoofing/tampering** — `assignedTo` in `POST /entities` is validated against
  `listUserIdsWithRole(orgId, "user")`, fails closed (rejects) when `orgId` is absent rather than
  skipping the check. No client-supplied value bypasses it.
- **Repudiation** — `createdBy` is still server-derived from the authenticated `userId`, never
  client-supplied; unchanged by this diff.
- **Elevation of privilege** — `GET /entities`'s `scopeToUserId` is derived only from the
  authenticated `userId` in the route handler, never from `rest.assignedTo` or any other query
  param for a non-privileged caller (confirmed by reading `list.ts` directly: the ternary sources
  `scopeToUserId` from `userId`, and `assignedTo` is `undefined` for non-privileged callers, so
  there is no path for a query param to widen scope). `getWorkflowByEntityTypeId` is untouched
  (confirmed — not present in this diff). The tenant-wide bare `GET /workflows` list widening is
  the one deliberate, spec-amended exception, tracked separately (see the spec's amendment note) —
  it exposes `WorkflowFull` (states/transitions/SLA config) tenant-wide, which is the intended,
  signed-off effect, not an accidental one.
- **Inappropriate assignment** — `assignedTo` pool is `role="user"` only, matching existing
  `GET /platform/users` filtering; unchanged reuse, not new logic.
- **DoS** — no new unthrottled endpoint; `listUserIdsWithRole` has no timeout/circuit-breaker
  (tracked as a non-blocking follow-up per the review, not a new DoS vector introduced here).

No HIGH or MEDIUM findings beyond the `get.ts` regression, which is fixed in this round.

| task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | requirement | status |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T5: Run `/security-review` against the STRIDE notes in the spec — spoofing/tampering (assignedTo validation), repudiation (createdBy not client-overridable), DoS (confirm existing throttling, if any, still applies — no new throttle added by design), elevation of privilege (confirm T1's chosen approach doesn't leak `isWorkflowAdmin`-gated data or touch `getWorkflowByEntityTypeId`), inappropriate assignment (role="user"-only pool, already existing UI behavior; no HIGH/MEDIUM findings, before and after implementation). | all         | done   |

---

## Kick-Off Prompt

Copy this into your Claude Code / AntiGravity session to start implementation:

```
Read docs/specs/workflow-open-ticket-creation.md and docs/specs/workflow-open-ticket-creation-tasks.md.

Implement Phase 1 tasks only (T1, T2, T3).

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass
- Each task's tests are written in the SAME commit as its implementation — never
  implementation without tests in the same pass
- After each task, run relevant tests and confirm pass before continuing
- T1: do not modify or refactor getWorkflowByEntityTypeId under any circumstance
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
```
