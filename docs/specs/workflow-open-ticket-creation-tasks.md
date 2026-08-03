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
