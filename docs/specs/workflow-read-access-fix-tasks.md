# Implementation Plan: Workflow Read Access Fix

**Spec:** docs/specs/workflow-read-access-fix.md
**Generated:** 2026-08-12
**Status:** not started

---

## Phase 1 — Route fix + tests

**Goal:** `GET /api/workflows/:id` returns 200 for any authenticated admin/agent/user
caller in-tenant, regardless of pre-existing ticket ownership; cross-tenant/nonexistent
ids still 404.
**Gate:** unit tests pass → then Phase 2

| task                                                                                                                                                                                                                                                                                                                                                                                      | requirement | status |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T1: Remove the `isGlobalAdmin`/`isWorkflowAdmin`/`entityId`/own-instance fallback authorization block in `apps/api/src/routes/workflows/get.ts` — route becomes `requireAuth()+requireRole(admin,agent,user)` → `getWorkflow(tx, tenantId, id, caller)` → `c.json({ data: workflow })`, 404 handled solely via `handleWorkflowError` catching the engine's own `WORKFLOW_NOT_FOUND` throw | R1, R4      | todo   |
| T2: Update `apps/api/src/routes/workflows/get.test.ts` — remove/replace tests asserting 404 for a non-owning non-admin `user`-role caller; add a test for a zero-ticket `user`-role caller → 200 with states/transitions populated; add a test for a `user`-role caller with an existing ticket → 200; keep the cross-tenant-id → 404 test                                                | R1, R2      | todo   |
| T3: Grep `apps/admin-ui` for callers of this endpoint passing `?entityId=` (e.g. `record-detail.tsx`) — confirm removing server-side use of that param has no behavioral effect on the client, or adjust the caller if it depended on entityId-driven authorization semantics                                                                                                             | R1          | todo   |
| T4: Grep `apps/api/tests/isolation/**` for any isolation test encoding the old ownership-gated-404 behavior for `GET /api/workflows/:id` — update if found                                                                                                                                                                                                                                | R1, R2      | todo   |

---

## Phase 2 — Review + ship

**Goal:** authz-loosening change on an auth-touching route passes security review and ships through the standard gate.
**Gate:** §R acceptance criteria met, all four exit-condition commands green

| task                                                                                                                                                                                    | requirement | status |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T5: `/security-review` on the diff — confirm no cross-tenant leak, confirm mutation routes (`assertWorkflowOwned`) untouched                                                            | R2, R3      | todo   |
| T6: Full exit condition (`pnpm typecheck && pnpm lint && pnpm test && pnpm test:isolation`), docs marker (`week-log.md`/`roadmap-tracker.md` if applicable, else `--skip`), commit + PR | R1–R4       | todo   |

---

## Kick-Off Prompt

Read docs/specs/workflow-read-access-fix.md and docs/specs/workflow-read-access-fix-tasks.md.

Implement Phase 1 tasks only (T1, T2, T3, T4).

Rules:

- Do not begin Phase 2 until all Phase 1 tests pass
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
