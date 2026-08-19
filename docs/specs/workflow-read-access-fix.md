# Workflow Read Access Fix (records-page 404 for zero-ticket users)

> Any authenticated tenant member (admin/agent/user) can GET a workflow's definition so the records page renders (even empty) and lets them create their first ticket there — matching the engine layer's existing "no secrets" design intent.

status: draft
created: 2026-08-12
updated: 2026-08-12

---

## §G Goal

`GET /api/workflows/:id` returns 200 with the workflow definition for any authenticated
tenant member holding role admin/agent/user, regardless of whether they own any existing
`entity_instances` in that workflow. Record-level privacy (users only ever seeing their own
tickets in list views) is unaffected — enforced elsewhere, at the entity-list query layer,
not at the workflow-read layer.

## §C Constraints

| constraint   | value                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack        | Hono route (`apps/api/src/routes/workflows/get.ts`), `@platform/workflow-engine` (`getWorkflow`)                                                                                                                                                                                                                                                      |
| auth         | `requireAuth()` + `requireRole("admin","agent","user")` already on the route; tenant isolation via `withTenantContext` unaffected                                                                                                                                                                                                                     |
| out of scope | Mutation routes (`assertWorkflowOwned` gating create/update/delete/canvas/state/transition CRUD) — unchanged. Record-level read access (which tickets a user can list) — unchanged, enforced in entity-list/entity-access code. Workflow _listing_ (`GET /api/workflows`) — already tenant-wide per existing comment in workflow-crud.ts, unaffected. |

## §I Interfaces

`GET /api/workflows/:id?entityId=<uuid>` (existing route, `apps/api/src/routes/workflows/get.ts`)

- Response body unchanged shape: `{ data: WorkflowFull }` (`id, name, entityTypeId, createdBy,
assignedTo, states[], transitions[]`, per `packages/workflow-engine/src/types.ts`).
- `createdBy`/`assignedTo` remain in the payload — admin-ui already uses them client-side to
  gate the settings page (per existing comment in `getWorkflow`).
- Cross-tenant / nonexistent workflow id: still 404 `WORKFLOW_NOT_FOUND` (from `getWorkflow`'s
  own not-found throw, tenant-scoped by `visibleTo(tenantId)` — untouched).

## §R Requirements

R1: Any authenticated caller with role admin, agent, or user can read a workflow's full
definition (states, transitions, createdBy, assignedTo) by id, within their own tenant,
regardless of whether they own any entity_instances in that workflow.
✓ Non-admin `user`-role caller with zero tickets in the workflow → `GET /api/workflows/:id`
returns 200 with states/transitions populated (not 404).
✓ Non-admin `user`-role caller with an existing ticket in the workflow → 200 (unchanged
behavior, now via the same unconditional path rather than the ownership fallback).
✓ Workflow admin (createdBy/assignedTo match) and global admin → 200, same response shape
as any other authorized-role caller (no more split by admin-ness).

R2: Cross-tenant or nonexistent workflow ids are indistinguishable — both 404
`WORKFLOW_NOT_FOUND`. Never 403.
✓ Requesting a workflow id belonging to another tenant → 404 `WORKFLOW_NOT_FOUND`.
✓ Requesting a random/nonexistent uuid → 404 `WORKFLOW_NOT_FOUND`.

R3: Mutation endpoints (update/delete/state & transition CRUD/canvas) remain gated by
`assertWorkflowOwned` exactly as before — this fix touches read access only.
✓ Existing `assertWorkflowOwned`-covered mutation tests continue to pass unmodified.

R4: The `?entityId=` and own-instance fallback-authorization logic in the current handler
is removed as dead code once the unconditional role-based read path replaces it — no
orphaned unused branches left in `get.ts`.
✓ `get.ts` has no remaining reference to `hasEntityReadAccess`/`toWorkflowCaller`-driven
authorization branching for this route, unless still needed elsewhere in the file.

## §V Invariants

- Workflow states/transitions/createdBy/assignedTo carry no tenant-member-restricted
  secrets — engine-layer design intent (`workflow-crud.ts` `getWorkflow` comment). Any
  future field added to `WorkflowFull` must be reviewed against this invariant before
  assuming it's safe to expose to every tenant member.
- Read access to a resource by id and mutation access to that same resource are gated
  independently — narrowing one must never be assumed to narrow the other, and vice versa.
- Cross-tenant existence is never leaked: unauthorized-by-tenant and nonexistent both
  return 404, never 403 (existing platform-wide convention, `.claude/rules/security.md`).

## §T Tasks

| id  | task                                                                                                                                                                                                                                                                | phase | status | depends     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ----------- |
| T1  | Remove the ownership/entityId/own-instance fallback authorization block in `apps/api/src/routes/workflows/get.ts`; route becomes `requireAuth()+requireRole(admin,agent,user)` → `getWorkflow` → `200`, relying on existing tenant-scoped 404 from the engine       | 1     | todo   | —           |
| T2  | Update/replace `apps/api/src/routes/workflows/get.test.ts` — remove tests asserting 404 for non-owning non-admin users; add tests for R1 (zero-ticket user → 200), keep/adjust cross-tenant 404 test (R2)                                                           | 1     | todo   | T1          |
| T3  | Grep admin-ui for any client relying on the removed `?entityId=` param semantics on this endpoint (e.g. `record-detail.tsx`) — confirm dropping the param has no effect (already inert once route ignores it) or update caller if it was doing something meaningful | 1     | todo   | T1          |
| T4  | Confirm no isolation test suite (`apps/api/tests/isolation/**`) currently encodes the old ownership-gated-404 behavior for this route; update if so                                                                                                                 | 1     | todo   | T1          |
| T5  | `/security-review` — this is an authz-loosening change on an auth-touching route                                                                                                                                                                                    | 2     | todo   | T1,T2,T3,T4 |

phase gate: all unit + integration tests pass before advancing to next phase

## §B Bugs / Backprop Log

| id  | what failed                                                                                                                                        | root cause                                                                                                                                                                                                                                                   | promoted to §V?                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| B1  | `GET /api/workflows/:id` returned 404 for a `user`-role caller with no tickets yet in that workflow, blocking the records page and ticket creation | Route-level ownership/entityId/own-instance-fallback gate added after commit dc2bb0c ("H2" fix) was stricter than the engine's own read-access design (`getWorkflow` intends universal tenant-member read) and never accounted for the zero-tickets-yet case | yes — added as new §V invariant on independent read/mutation gating |

---

_spec is source of truth — update as decisions are made_
