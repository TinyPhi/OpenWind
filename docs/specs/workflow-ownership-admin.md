# Per-Workflow Ownership & Admin Model

> Any authenticated tenant member can create their own workflow (and becomes its admin
> automatically); a workflow's `assignedTo` array plus its `createdBy` are the source of
> truth for who else can administer it, alongside the global `admin` role which bypasses
> per-workflow checks entirely. Written retroactively (2026-07-22) to close a documentation
> gap found during a pre-PR review — the code already correctly implements everything below;
> nothing here changes behavior.

status: implemented
created: 2026-07-22 (retroactive — feature shipped via PR #155, `feat/PLAT-workflow-ownership-admin`)
updated: 2026-07-22

---

## §G Goal

Let any authenticated user — not just global admins — build and own their own workflow
(entity type + states + transitions), without granting them tenant-wide schema-admin rights.
Ownership of a specific workflow is tracked per-workflow, not via the global role system.

## §C Constraints

| constraint   | value                                                                                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack        | Hono routes, `packages/workflow-engine`, Drizzle ORM                                                                                                                                          |
| global roles | Exactly four: `admin`, `agent`, `user` (customer), `superadmin`. No per-workflow role exists in the JWT/role system — per-workflow admin status is data (a DB column), not a role.            |
| out of scope | Transferring ownership between users after creation via a dedicated endpoint (today: only achievable by a global/workflow admin calling `PATCH /workflows/:id` with a new `assignedTo` array) |

## §I Interfaces

`workflows` table carries the ownership data:

```
created_by   uuid          -- set once, at creation, never changes
assigned_to  uuid[]         -- the "admins" list; seeded with [createdBy] at creation
```

Authorization (`packages/workflow-engine/src/authorization.ts`):

```ts
isWorkflowAdmin(userId, workflow) =
  workflow.createdBy === userId || workflow.assignedTo.includes(userId);

isWorkflowAdminListEditor(userId, workflow) = workflow.createdBy === userId; // only the original creator can edit the assignedTo list itself
```

Global `admin` role bypasses both checks entirely at the route layer (`caller.isGlobalAdmin`)
— callers check that first and short-circuit before reaching `isWorkflowAdmin`.

## §R Requirements

R1: Any authenticated tenant member (`admin`, `agent`, or `user`/customer) can create a new
workflow from scratch via the admin-ui "New Workflow" flow.
✓ `POST /entity-types` (creates the workflow's 1:1 backing entity type — step 1) and
`POST /workflows` (step 2) both allow `admin`, `agent`, `user` at the route layer
(`requireRole("admin", "agent", "user")`) with no additional route-level restriction, since
at creation time there is no existing workflow to check ownership against.
✓ `apps/admin-ui/src/components/layout.tsx`'s Workflows nav link and
`apps/admin-ui/src/pages/workflows/index.tsx`'s "New Workflow" button are shown unconditionally
to every authenticated role — this is intentional, not a missing UI guard.

R2: The creator of a workflow automatically becomes that workflow's admin.
✓ `createWorkflow` (`packages/workflow-engine/src/workflow-crud.ts:94-116`) seeds
`assignedTo: [createdBy]` on every insert — no separate "add yourself as admin" step required.
✓ `isWorkflowAdmin` also independently checks `createdBy === userId` (belt-and-suspenders —
true even if a future code path ever creates a workflow without seeding `assignedTo`).

R3: Once a workflow exists, only its admins (creator + anyone in `assignedTo`) or a global
`admin`/`superadmin` can mutate it — states, transitions, or the `assignedTo` list itself.
✓ `updateWorkflow`, `deleteWorkflow`, workflow-state/transition CRUD, and
`entity-types/fields/*` (via `assertFieldWorkflowAccess`, since fields live on the entity type
1:1 with the workflow) all call `isWorkflowAdmin`/`isWorkflowAdminListEditor` internally.
✓ Route-level `requireRole("admin", "agent", "user")` on these mutation routes is deliberately
coarse ("must be an authenticated tenant member") — the real authorization is the internal
per-workflow check, not the route guard. Do not "fix" these routes to be role-restrictive at
the route layer; that would break every non-global-admin's ability to manage their own
workflow.

R4: `POST /entity-types` (bare schema creation, not gated behind workflow creation) is
**intentionally** as open as workflow creation itself, not admin-only — because it is workflow
creation's first step, not a separate standalone operation. There is currently no mechanism to
distinguish "creating an entity type as step 1 of my own new workflow" from "creating an
arbitrary orphan entity type"; both are allowed, and that is accepted as within scope of R1
(self-service workflow creation necessarily includes creating its backing type).
✓ `entity-types/create.test.ts` must assert 201 for admin, agent, and user callers alike — a
403 expectation for agent/user on this route is a **misunderstanding of intended behavior**,
not a security fix. (This spec exists specifically because that misunderstanding shipped as a
test in a previous session — see §B.)

R5: `GET /users` intentionally returns every org member (including email) to any authenticated
role, including `user`/customer.
✓ Customers need this to resolve human-readable assignee names on their own records
(see inline comment at `apps/api/src/routes/platform/users.ts:18`).
✓ Accepted tradeoff, not a gap: full org member visibility (names + emails) is available to
any tenant member. Revisit only if a future requirement demands hiding staff emails from
customers specifically — no such requirement exists today.

## §V Invariants

- A workflow's `assignedTo` array (plus `createdBy`) is the **only** source of truth for
  per-workflow admin rights. There is no separate "workflow admin" global role, and there
  never should be — per-workflow granularity is the entire point of this model.
- `entity-types/create.ts`, `workflows/create.ts`, and every workflow-mutation route
  (`update.ts`, `delete.ts`, states/transitions CRUD, `entity-types/fields/*`) must keep
  `requireRole("admin", "agent", "user")` at the route layer. Do not tighten these to
  `admin`-only or `admin, agent` — that breaks R1/R3 for every non-global-admin user.
- Any route that mutates an _existing_ workflow's structure must call `isWorkflowAdmin` (or
  `isWorkflowAdminListEditor` for the `assignedTo` list itself) internally — the route-level
  role check alone is never sufficient for those routes.
- Global `admin` (and `superadmin` where applicable) always bypasses per-workflow checks —
  never require a global admin to also appear in a workflow's `assignedTo` array.

## §T Tasks

| id  | task                                                                              | phase | status        | depends |
| --- | --------------------------------------------------------------------------------- | ----- | ------------- | ------- |
| T1  | `assignedTo`/`createdBy` columns + `isWorkflowAdmin`/`isWorkflowAdminListEditor`  | 1     | done          | —       |
| T2  | Wire internal checks into `updateWorkflow`/`deleteWorkflow`/state+transition CRUD | 1     | done          | T1      |
| T3  | Wire `assertFieldWorkflowAccess` into `entity-types/fields/*`                     | 1     | done          | T1      |
| T4  | admin-ui: unconditional Workflows nav + New Workflow flow for all roles           | 1     | done          | —       |
| T5  | Correct `entity-types/create.test.ts` to assert 201 for agent/user (not 403)      | 2     | done — see §B | R4      |
| T6  | Write this spec (retroactive documentation)                                       | 2     | done          | —       |

## §B Bugs / Backprop Log

| id  | what failed                                                                                                                                                  | root cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | promoted to §V?  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| B1  | `entity-types/create.test.ts` asserted 403 for agent/user callers, and a matching route change was almost shipped locking `POST /entity-types` to admin-only | A prior session wrote a test (and comment) assuming entity-type creation should mirror its `update.ts`/`delete.ts` siblings (admin-only), without accounting for its dual role as workflow-creation's first step. The route's actual, correct, and intentional behavior (open to any authenticated user) was never documented anywhere, so the mismatch wasn't caught until a full pre-PR review traced the admin-ui nav's "users can create workflows" comment back to this route. | yes — see R4, §V |

---

_spec is source of truth — update as decisions are made_
