# Per-Workflow Ownership/Admin Model

> Retroactive spec for PR #155 (`feat/PLAT-workflow-ownership-admin`, merged 2026-07-21). Migration
> `packages/db/migrations/0035_workflow_created_by.sql` referenced this file's path before it
> existed — written now, alongside `docs/sup-docs/adr-006-draft-per-workflow-ownership-admin-model.md`
> (staged for migration to `docs/decisions/ADR-006-...md`), to close that gap.

status: shipped (retroactively specified)
created: 2026-07-23
updated: 2026-07-23

---

## §G Goal

Let a `user`-role caller who builds/owns a workflow (e.g. via the Phase 2D no-code workflow
editor) manage every record flowing through _that workflow_ — read, edit, comment, attach,
approve access requests, create sub-tickets, view history — without needing the tenant to grant
them the global `agent`/`admin` role (which would over-grant access to every workflow, not just
theirs). Ownership is expressed as data (`workflows.created_by`/`assigned_to[]`), not a new role.

## §C Constraints

| constraint   | value                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack        | `packages/workflow-engine` (predicate + workflow-definition CRUD guard), `apps/api/src/lib/entity-access.ts` (record-level composition), ~20 route handlers under `apps/api/src/routes/`                |
| pattern ref  | ADR-006 (per-workflow ownership/admin model) for the authorization decision; ADR-002 (workflow engine) for the FSM this sits alongside                                                                  |
| roles        | Only `agent`/`admin` are real global roles (same as every other module) — ownership is additive to RBAC, never a replacement or a new role string                                                       |
| composition  | Must widen access, never narrow it: `roles.includes("admin"/"agent")` is always checked first; ownership is an additive fallback (logical OR), never an AND restriction on an already-privileged caller |
| out of scope | Transition-time gating (`executeTransition` stays role-only — ADR-006 Resolved WA-01); direct-grant parity in `grant-access.ts` (tracked as a separate follow-up issue, ADR-006 WA-03)                  |
| isolation    | `workflows`/`workflow_states`/`workflow_transitions`/`entity_types` have no RLS (issue #136) — ownership checks (`assertWorkflowOwned`/`visibleTo`) are the _only_ isolation boundary today             |

## §I Interfaces

- `packages/workflow-engine/src/authorization.ts`:
  `isWorkflowAdmin(userId, { createdBy, assignedTo }): boolean` — `createdBy === userId || assignedTo.includes(userId)`.
  `isWorkflowAdminListEditor(userId, { createdBy }): boolean` — creator-only, gates editing a workflow's own `assignedTo[]`.
- `packages/workflow-engine/src/workflow-crud.ts`:
  `assertWorkflowOwned(db, tenantId, workflowId, caller)` — 404s (not 403) unless `caller.isGlobalAdmin` or `isWorkflowAdmin`. Gates `addWorkflowState`/`updateWorkflowState`/`deleteWorkflowState`/`addWorkflowTransition`/`updateWorkflowTransition`/`deleteWorkflowTransition`/`updateWorkflow`.
  `visibleTo`/`ownedByCaller` — read-side workflow listing: system templates (`tenant_id = null`) visible to all; tenant-owned workflows visible to global admins (all) or non-privileged callers (only their own, via `assignedTo @> ARRAY[userId]`).
- `apps/api/src/lib/entity-access.ts`:
  `hasEntityAccess(tx, tenantId, instance, userId, roles): Promise<boolean>` — `hasEntityReadAccess(...) || (instance.workflowId && isWorkflowAdmin(userId, await getWorkflow(...)))`. The one function every record-level route should call when the instance's `workflowId` is available.
  `hasEntityReadAccess(instance, userId, roles): boolean` — role check, then `createdBy`/`assignedTo`, then `__accessUsers[userId].level` — used where a workflow round-trip isn't wanted/available.
- Schema (`packages/db/src/schema/workflow-engine.ts`, migration `0035_workflow_created_by.sql`):
  `workflows.created_by text`, `workflows.assigned_to text[]`.

## §R Requirements

R1: A workflow's creator is always an implicit admin of that workflow, immutably.
✓ `created_by` set once at insert time, never mutated by any route
✓ `isWorkflowAdmin` treats `createdBy === userId` as sufficient on its own, independent of `assignedTo`

R2: A workflow's `assigned_to[]` members get the same record-level access as its creator.
✓ `isWorkflowAdmin` treats `assignedTo.includes(userId)` as equally sufficient
✓ Applies uniformly across read, edit, comment, attach, access-request-resolve, sub-ticket-create, and all history-listing routes that call `hasEntityAccess`/`isWorkflowAdmin`

R3: Only the creator (or a global admin) may edit a workflow's `assigned_to[]`.
✓ `updateWorkflow` gates the `assignedTo` field specifically behind `isWorkflowAdminListEditor`, distinct from the broader `isWorkflowAdmin` gate used elsewhere
✓ The creator can never be removed from `assigned_to[]` by a non-admin caller (`WORKFLOW_ADMIN_REMOVE_CREATOR_FORBIDDEN`), closing the obvious self-lockout/escalation path for `user`-role callers — a global `admin` can still remove the creator; this guard is application-code-only, with no DB constraint backing it (migration `0035`'s own comment notes this explicitly)

R4: Ownership composes with RBAC additively — it never narrows what a global role already grants.
✓ Every route checked follows `isPrivileged = roles.includes("admin"/"agent"); if (!isPrivileged) isPrivileged = isWorkflowAdmin(...)` — RBAC short-circuits first
✓ No route exists where an `admin`/`agent` caller is blocked by an ownership check

R5: Ownership composes with the `__accessUsers` access-request/grant/revoke layer (PR #144) as a third equally-valid approver.
✓ `resolve-access-request.ts` and `revoke-access.ts` accept: record owner (`createdBy`/`assignedTo`), OR global `admin`/`agent`, OR workflow admin
✓ `grant-access.ts` (direct grant, bypassing the request flow) currently accepts only global `admin`/`agent` — tracked inconsistency, not yet fixed (see ADR-006 WA-03)

R6: Workflow-definition mutations (states/transitions) are gated the same way as record access, at 404 not 403.
✓ All 6 state/transition CRUD entry points call `assertWorkflowOwned`, which throws `WORKFLOW_NOT_FOUND` (404) rather than a 403 on a workflow the caller doesn't own — consistent with the platform's cross-tenant-resource convention (never leak existence via 403)

R7: Transition execution itself does not consult ownership — role-only, by deliberate accepted policy (ADR-006 WA-01).
✓ `executeTransition`'s guard sequence (allowed roles → conditions → requires-fields → requires-comment) never reads `createdBy`/`assignedTo`/`__accessUsers`, confirmed by direct read of `packages/workflow-engine/src/engine.ts`
✓ This is intentional, not an oversight — documented independently in `docs/specs/tender-management.md` and now here

## §V Invariants

- `isWorkflowAdmin` is the single source of truth for the ownership predicate — do not reimplement the `createdBy === userId || assignedTo.includes(userId)` check inline anywhere new; import it.
- Ownership is always additive to RBAC. Any new route that checks `roles` for privilege must check the global role allow-list first and treat ownership as an `||`, never restrict an already-privileged role's access.
- The workflow creator can never be removed from `assigned_to[]` by a non-admin caller — this is enforced in code (`WORKFLOW_ADMIN_REMOVE_CREATOR_FORBIDDEN`), not just convention. A global `admin` caller is exempt from this guard and can remove the creator; the guard itself has no database-level backing (application code only, per migration `0035`'s own comment).
- `executeTransition` stays role-only. If a future module needs per-instance transition gating, that is an engine-level change (new primitive, per ADR-004's escape-hatch rule) — never a module-level workaround, never a per-module role string.
- `workflows`/`workflow_states`/`workflow_transitions`/`entity_types` have no RLS — `assertWorkflowOwned`/`visibleTo` are the only isolation boundary on these four tables until issue #136 is resolved. Do not weaken these checks on the assumption RLS is a backstop; it isn't, yet.
- Cross-tenant or unowned-workflow access always returns 404, never 403.

## §B Bugs / Backprop Log

- None yet — this spec is written after the fact from a clean code read (ADR-006's research pass), not from a bug encountered during implementation of this doc.
