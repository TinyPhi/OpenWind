# Ticket-to-Ticket Reference Linking

> Cross-workflow, cross-module "this continues/relates to that" links between entity instances, with zero workflow side effects — for when a ticket's work in workflow A is done but the real-world process continues in a new ticket in workflow B.

status: draft
created: 2026-08-04
updated: 2026-08-04

---

## §G Goal

User viewing ticket A can link it to ticket B (any entity type / workflow / module) as
"references" / "referenced by". Both tickets show the link and can navigate to each
other. Neither ticket's workflow state, transitions, SLA, or automations are affected by
the link existing, changing, or being removed. Many-to-many: a ticket may reference /
be referenced by any number of other tickets.

## §C Constraints

| constraint   | value                                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| stack        | Hono API (`apps/api`), Drizzle (`packages/db`), `packages/entity-engine`, admin-ui (Refine + shadcn)                                                                                 |
| auth         | `requireAuth()`; per-call access check via existing `hasEntityAccess` (not a fixed role gate) — see R2                                                                               |
| storage      | Reuses `entity_relations` table as-is (`packages/db/src/schema/entity-engine.ts`) — **no migration**                                                                                 |
| prior art    | `packages/entity-engine/src/entity-relations.ts` (generic relation CRUD), `packages/entity-engine/src/child-relations.ts` (relation-pair pattern, minus its workflow-coupling logic) |
| module rule  | This is engine/API/admin-ui TypeScript, not module seed SQL — ADR-004's "zero TypeScript in `modules/`" does not apply; nothing added under `modules/`                               |
| out of scope | No cap on link count; no cross-tenant links (impossible — tenant-scoped queries); no workflow/state coupling of any kind; no new list endpoint                                       |

## §I Interfaces

**Relation types** (in `entity-relations.ts`, sibling to `RELATION_PARENT_OF`/`RELATION_CHILD_OF`):

```
RELATION_REFERENCES     = "references"
RELATION_REFERENCED_BY  = "referenced_by"
```

**New engine function** — `createReferenceLink(db, tenantId, { fromInstanceId, toInstanceId })`
→ `{ relations: EntityRelation[] }` (the mirrored pair), or throws `EntityError`.

**New routes** (`apps/api/src/routes/entities/`):

| method | path                                                             | auth                                                   | notes                                              |
| ------ | ---------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------- |
| POST   | `/entities/:id/references`                                       | `requireAuth()` + `hasEntityAccess` on **both** sides  | body `{ toInstanceId: uuid }`; 201 → relation pair |
| DELETE | `/entities/:id/references/:relationId`                           | `requireAuth()` + `hasEntityAccess` on `:id` side only | 204; unilateral unlink                             |
| GET    | `/entities/:id/relations?relationType=references&direction=both` | existing route, unchanged                              | listing — no new endpoint                          |

**Errors:** cross-tenant / no-access on either side → `404` (never `403` — see `security.md`).
New `EntityError` codes: `RELATION_SELF_LINK`, `RELATION_ALREADY_EXISTS`.

## §R Requirements

R1: A user with access to two tickets can create a bidirectional reference link between them, regardless of entity type, workflow, or module.
✓ `POST /entities/:id/references { toInstanceId }` with both tickets accessible to caller → 201, two rows in `entity_relations` (`references` A→B, `referenced_by` B→A)
✓ Works when A and B belong to different entity types / different workflows / different modules

R2: Only a user with access to _both_ the source and target ticket may create the link.
✓ Caller has `hasEntityAccess` true on `:id` (admin/agent/creator/assignee/ACL/workflow-admin) — checked
✓ Caller has `hasEntityAccess` true on `toInstanceId` — checked
✓ Missing access on either side → `404` (not `403`, not "leak that the other ticket exists")

R3: A ticket cannot be linked to itself.
✓ `fromInstanceId === toInstanceId` → rejected with `RELATION_SELF_LINK`, no rows inserted

R4: Duplicate active links between the same ordered pair are rejected.
✓ An existing non-deleted `references` row for (A→B) blocks a second `POST` for the same pair → `RELATION_ALREADY_EXISTS`
✓ Does not block linking A→C or D→B (only the exact pair is deduped)

R5: Either linked party can remove the link unilaterally.
✓ `DELETE /entities/:id/references/:relationId` succeeds if caller has access to `:id`'s instance, regardless of whether they have access to the other side
✓ Soft-deletes both mirrored rows (the `references` row and its paired `referenced_by` row)

R6: The link has no effect on either ticket's workflow.
✓ Transitioning, closing, archiving, or soft-deleting ticket A does not alter ticket B's state, and vice versa
✓ No automation/SLA/notification is triggered by link creation or removal (unlike `entity.created`/`workflow.transitioned`, no outbox event is emitted for this feature)

R7: A linked ticket that has since been soft-deleted still appears in the list, marked as unavailable.
✓ `GET .../relations?relationType=references` includes the relation row even if the target instance is soft-deleted
✓ Admin-ui renders it as "Linked ticket (deleted)" — grayed out, non-navigable — rather than a broken link or silent omission

R8: The link-picker search is scoped to tickets the caller can already access.
✓ Search results in the "Link ticket" modal never include a ticket outside the caller's own accessible set, even before the link-creation access check runs

## §V Invariants

- `entity_relations` rows for `references`/`referenced_by` are always inserted as a mirrored pair in one transaction — never one without the other.
- Reference links never gate, block, or alter a `workflow_transitions` state change — this feature must never gain a dependency on `packages/workflow-engine`'s transition path.
- Cross-tenant existence of either side is never distinguishable from "not found" in any response (404, never 403) — see `security.md` R on resource existence leaks.
- No entity-type/workflow restriction is ever added to `createReferenceLink` — if a future need arises to restrict it, that's a new, explicit requirement, not a silent tightening.

## §T Tasks

| id  | task                                                                                                                           | phase | status | depends |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ----- | ------ | ------- |
| T1  | Add `RELATION_REFERENCES`/`RELATION_REFERENCED_BY` + `createReferenceLink` in `entity-relations.ts`, with self-link/dup checks | 1     | todo   | —       |
| T2  | Add `EntityError` codes `RELATION_SELF_LINK`, `RELATION_ALREADY_EXISTS` + map in `handle-entity-error.ts`                      | 1     | todo   | T1      |
| T3  | `POST /entities/:id/references` route with dual `hasEntityAccess` check                                                        | 1     | todo   | T1,T2   |
| T4  | `DELETE /entities/:id/references/:relationId` route with single-side `hasEntityAccess` check                                   | 1     | todo   | T1,T2   |
| T5  | Unit tests: `createReferenceLink` (self-link, duplicate, cross-entity-type, deleted target)                                    | 1     | todo   | T1      |
| T6  | Route tests: access-both-sides-required, 404-not-403, unilateral delete                                                        | 1     | todo   | T3,T4   |
| T7  | Isolation tests: cross-tenant link blocked, cross-tenant delete blocked                                                        | 1     | todo   | T3,T4   |
| T8  | Admin-ui: "Linked tickets" section on `record-detail.tsx` (list both directions, deleted-target badge)                         | 2     | todo   | T3      |
| T9  | Admin-ui: "Link ticket" modal — access-scoped search + select, calls `POST`                                                    | 2     | todo   | T8      |
| T10 | Admin-ui: unlink action (confirm + `DELETE`)                                                                                   | 2     | todo   | T8      |

phase gate: all unit + integration + isolation tests pass (phase 1) before phase 2 UI work begins

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |

---

_spec is source of truth — update as decisions are made_
