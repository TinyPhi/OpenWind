# Child Tickets

> Structured parent-child ticket hierarchy for the helpdesk module — work decomposition with downward visibility and stateless child execution units.

status: approved
created: 2026-06-30
updated: 2026-06-30

---

## §G Goal

Agents can break a top-level ticket into child tickets. Each child is an independent execution unit (open/closed), assigned to one agent. The parent assignee sees all children. Children see only their own ticket. Re-parenting, archiving, and restoring all behave correctly within workflow-configured depth and count limits.

---

## §C Constraints

| constraint           | value                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack                | TypeScript · Hono · Drizzle · Postgres · Refine + shadcn/ui                                                                                       |
| auth                 | Zitadel JWT; roles: admin, agent, user                                                                                                            |
| existing infra       | entity_relations table (no deleted_at yet); entity_instances (deleted_at, assigned_to, workflow_id, current_state)                                |
| access layer         | query-time upward walk — no propagation writes, no ticket_participants table                                                                      |
| child state model    | open / closed only — no transition engine, no workflow_id on children                                                                             |
| child fields         | fixed minimal set: title (required), assigned_to, due_date, description — stored in fields JSONB; no entity_fields schema applied to children     |
| top-level tickets    | full workflow transitions unchanged                                                                                                               |
| hard delete          | never — archive only (set deleted_at)                                                                                                             |
| depth default        | 1 (parent → child; no grandchild by default)                                                                                                      |
| children cap default | 10 per parent                                                                                                                                     |
| both limits          | configurable per workflow in workflow settings                                                                                                    |
| out of scope         | @mention access grants, watcher role, sibling visibility, parallel approval, blocks/blocked_by enforcement, auto-rollup of child states to parent |

---

## §I Interfaces

### Workflow settings additions

```
workflows table:
  max_child_depth        INTEGER NOT NULL DEFAULT 1   -- 0 = children disabled
  max_children_per_parent INTEGER NOT NULL DEFAULT 10
```

### entity_relations additions

```
entity_relations table:
  deleted_at   TIMESTAMPTZ   -- NULL = active; set on soft-delete of either endpoint
```

### Child ticket fields

Stored entirely in `entity_instances.fields` JSONB. Fixed minimal set — no `entity_fields` schema lookup, no dynamic field rendering for children.

```
{
  "title":       string   (required)
  "assignedTo":  string   (user ID, optional)
  "dueDate":     string   (ISO date, optional)
  "description": string   (optional)
  "childStatus": "open" | "closed"   (managed by system; defaults to "open" on create)
}
```

- `childStatus` is the only system-managed field; the rest are user-supplied at creation.
- The create form shows exactly these 4 user fields: title, assigned to (picker), due date, description.
- No other fields from the parent entity type are shown or required.
- Children never have `workflow_id` set; `current_state` stays null.
- Top-level tickets never have `childStatus` in fields.

### Relation types used

| relation_type | meaning                                       |
| ------------- | --------------------------------------------- |
| `parent_of`   | written on the parent instance                |
| `child_of`    | written on the child instance (always paired) |

Both rows inserted in same transaction. Deletion removes both.

### New / modified API endpoints

| method  | path                | role                          | purpose                                                                                     |
| ------- | ------------------- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| `POST`  | `/:id/children`     | admin, agent                  | create child ticket under parent :id                                                        |
| `GET`   | `/:id/children`     | admin, agent, assignee-of-:id | list children of :id                                                                        |
| `PATCH` | `/:id/parent`       | admin, agent                  | re-parent :id to a new parent (body: `{ parentId }`) or detach (body: `{ parentId: null }`) |
| `PATCH` | `/:id/child-status` | admin, agent, assignee-of-:id | set child_status open/closed                                                                |
| `POST`  | `/:id/archive`      | admin, agent                  | archive :id (+ cascade to descendants) with confirm flag                                    |
| `POST`  | `/:id/restore`      | admin, agent                  | restore :id (+ cascade to descendants)                                                      |

Existing `POST /:id/relations` remains for non-hierarchy relation types.
`DELETE /:id/relations/:relationId` now sets `deleted_at` (soft) instead of hard-delete.

### Access check (query-time)

```
canRead(userId, instanceId):
  1. instance.assigned_to = userId  → allow
  2. walk instance's parent chain (up to max_child_depth joins):
       for each ancestor: ancestor.assigned_to = userId → allow
  3. user has role admin or agent  → allow
  4. else → 404 (never 403)
```

---

## §R Requirements

**R1: Create child ticket**
A child ticket can be created under a parent ticket.
✓ POST `/:id/children` creates entity_instance + two entity_relations rows (`parent_of` + `child_of`) in one transaction
✓ Request body: `{ title: string, assignedTo?: string, dueDate?: string, description?: string }`
✓ Child instance has no `workflow_id`, `current_state` = null; fields JSONB = `{ title, assignedTo, dueDate, description, childStatus: "open" }`
✓ `entity_fields` schema for the parent entity type is NOT applied — only the fixed 4 fields are accepted
✓ Returns 201 with child ticket data including parent reference
✓ Returns 400 if parent itself is a child and workflow.max_child_depth would be exceeded

**R2: One-parent constraint**
A ticket may have at most one active `child_of` relation.
✓ Attempting to create a second `child_of` on the same instance returns 409 with message "Ticket already has a parent"
✓ Constraint checked before any insert

**R3: Depth limit enforcement**
The full ancestor chain must not exceed `workflow.max_child_depth`.
✓ On create child: count ancestor levels of parent; reject if count ≥ max_child_depth
✓ On re-parent: count (ancestors of new parent) + 1 + (deepest descendant of moving ticket); reject if total > max_child_depth
✓ Error message includes current chain length and configured limit: "Would create a chain of {n} levels; this workflow allows {max}"
✓ Default max_child_depth = 1 prevents grandchildren unless admin changes it

**R4: Children cap enforcement**
A parent may not exceed `workflow.max_children_per_parent` active children.
✓ Count active (non-archived) `parent_of` relations on parent before insert; reject if at limit
✓ Error: "Parent ticket has reached the maximum of {max} children"
✓ Default cap = 10

**R5: Cycle detection**
A ticket cannot become a descendant of itself.
✓ On create child or re-parent: walk descendants of the would-be child; reject if new parent appears in that set
✓ Error: "Cannot attach — would create a circular relationship"
✓ Lock: SELECT FOR UPDATE on the would-be child row before the walk (prevents concurrent race)

**R6: Child state management**
Child tickets have exactly two states: open and closed.
✓ PATCH `/:id/child-status` accepts `{ status: "open" | "closed" }` only
✓ Assignee of the child OR admin/agent can update
✓ End-users (non-agent, non-admin) get 403
✓ Top-level tickets (no `child_of` relation) return 400 on this endpoint

**R7: Downward visibility**
Parent assignee can read all children. Children cannot read parent content.
✓ GET `/:parentId` by parent's assignee returns 200
✓ GET `/:childId` by child's assignee returns 200
✓ GET `/:parentId` by child's assignee (not assigned to parent) returns 404
✓ GET `/:siblingId` by any child's assignee returns 404
✓ GET `/:id/children` by parent's assignee returns full child list
✓ Admin/agent role bypasses all of the above (sees everything in tenant)

**R8: Re-parenting**
A child ticket can be moved to a new parent or detached (become top-level).
✓ PATCH `/:id/parent` with `{ parentId: "<newId>" }` removes old relation pair, validates new chain, inserts new relation pair — all in one transaction
✓ PATCH `/:id/parent` with `{ parentId: null }` detaches ticket (becomes top-level, gains workflow_id from its entity type default if applicable)
✓ Depth + cap + cycle checks run against the new parent before any write
✓ Fails atomically — old relation intact if new one would violate any constraint

**R9: Archive with cascade**
Archiving a ticket with children archives all descendants.
✓ POST `/:id/archive` without `{ confirm: true }` in body returns 200 with `{ requiresConfirm: true, childCount: n }` when children exist — no writes yet
✓ POST `/:id/archive` with `{ confirm: true }` sets `deleted_at = now()` on the instance and all active descendants in one transaction
✓ `entity_relations.deleted_at` set on all relations where either endpoint is now archived
✓ Archived tickets return 404 on GET (to non-admin callers)
✓ Admin can list archived tickets via `GET /entities?archived=true`

**R10: Restore with cascade**
Restoring a ticket restores all descendants to their state at archive time.
✓ POST `/:id/restore` clears `deleted_at` on the instance and all descendants whose `deleted_at` matches the archive transaction timestamp (same timestamp = same archive event)
✓ Each restored instance returns to its exact pre-archive state (workflow state, child_status, assignee, fields — all unchanged)
✓ Relations restored: clear `deleted_at` on all relation rows linking restored instances
✓ Descendants archived independently (different `deleted_at`) are NOT restored by parent restore

**R11: Workflow settings configurable**
Admins can adjust depth and children limits per workflow.
✓ PATCH `/workflows/:id` accepts `max_child_depth` (integer ≥ 0) and `max_children_per_parent` (integer ≥ 1)
✓ Reducing limits does not retroactively break existing chains — only enforced on new creates/re-parents
✓ `max_child_depth = 0` disables child ticket creation entirely for that workflow (POST `/:id/children` returns 400)

**R12: Child ticket reference display**
Child tickets show their parent reference; parent tickets show child list.
✓ GET `/:id` response includes `parentId: string | null` and `childCount: number` for all tickets
✓ GET `/:id/children` returns paginated list of direct children with their `child_status`
✓ Parent reference included even for child's assignee (they can see the ID, not the parent's content)

---

## §V Invariants

- A ticket never has more than one active `child_of` relation at any time
- `parent_of` and `child_of` rows are always inserted and deleted together (no orphan halves)
- `entity_relations.deleted_at` is set whenever either endpoint instance has `deleted_at` set
- Depth check counts the full chain (ancestors above new parent + new link + descendants below moving ticket)
- Cycle detection lock (`SELECT FOR UPDATE`) always acquired before walking descendants
- Access check returns 404, never 403, for cross-tenant or inaccessible resources
- Child tickets never have `workflow_id` set; top-level tickets never have `child_status` in fields
- Archive/restore is always a single transaction covering all descendants
- Re-parent is atomic: old relation removed and new relation inserted or nothing changes
- Reducing workflow depth/cap limits never invalidates existing valid chains
- Child creation never runs entity_fields schema validation — only Zod validates the fixed 4-field shape
- `childStatus`, `assignedTo`, `dueDate`, `description` keys are reserved in child fields JSONB; no user-defined key may shadow them

---

## §T Tasks

| id  | task                                                                                                 | phase | status | depends  |
| --- | ---------------------------------------------------------------------------------------------------- | ----- | ------ | -------- |
| T1  | Migration: add `deleted_at` to `entity_relations`                                                    | 1     | todo   | —        |
| T2  | Migration: add `max_child_depth` + `max_children_per_parent` to `workflows` table                    | 1     | todo   | —        |
| T3  | Drizzle schema + types updated for both migrations                                                   | 1     | todo   | T1, T2   |
| T4  | `createRelation()`: add one-parent constraint check                                                  | 2     | todo   | T3       |
| T5  | `createRelation()`: add depth limit check (walk ancestors)                                           | 2     | todo   | T3       |
| T6  | `createRelation()`: add children cap check                                                           | 2     | todo   | T3       |
| T7  | `createRelation()`: add cycle detection with SELECT FOR UPDATE                                       | 2     | todo   | T3       |
| T8  | `deleteRelation()`: soft-delete (set deleted_at) instead of hard-delete                              | 2     | todo   | T3       |
| T9  | New `moveRelation()` engine fn: atomic re-parent with full validation                                | 2     | todo   | T4–T8    |
| T10 | Entity engine access check: bounded upward walk in `getEntity()` + `listEntities()`                  | 2     | todo   | T3       |
| T11 | Archive cascade: `archiveEntity()` engine fn — sets deleted_at on instance + descendants + relations | 2     | todo   | T3       |
| T12 | Restore cascade: `restoreEntity()` engine fn — clears deleted_at by matching archive timestamp       | 2     | todo   | T11      |
| T13 | Unit tests: constraint enforcement (one-parent, depth, cap, cycle)                                   | 2     | todo   | T4–T7    |
| T14 | Unit tests: archive/restore cascade correctness                                                      | 2     | todo   | T11, T12 |
| T15 | API route: `POST /:id/children`                                                                      | 3     | todo   | T4–T7    |
| T16 | API route: `GET /:id/children`                                                                       | 3     | todo   | T10      |
| T17 | API route: `PATCH /:id/parent` (re-parent + detach)                                                  | 3     | todo   | T9       |
| T18 | API route: `PATCH /:id/child-status`                                                                 | 3     | todo   | T10      |
| T19 | API route: `POST /:id/archive` with confirm flow                                                     | 3     | todo   | T11      |
| T20 | API route: `POST /:id/restore`                                                                       | 3     | todo   | T12      |
| T21 | Enrich `GET /:id` response with `parentId` + `childCount`                                            | 3     | todo   | T10      |
| T22 | Integration tests: access check (parent sees children, child sees only own, sibling 404)             | 3     | todo   | T15–T21  |
| T23 | Integration tests: archive cascade + restore cascade                                                 | 3     | todo   | T19, T20 |
| T24 | Integration tests: re-parent depth/cycle/cap validation                                              | 3     | todo   | T17      |
| T25 | Isolation tests: cross-tenant relation walk returns nothing                                          | 3     | todo   | T10      |
| T26 | UI: child creation flow (button on parent ticket, form, parent badge on child)                       | 4     | todo   | T15, T21 |
| T27 | UI: child list panel on parent ticket detail                                                         | 4     | todo   | T16      |
| T28 | UI: re-parent / detach action                                                                        | 4     | todo   | T17      |
| T29 | UI: archive confirmation dialog (shows child count)                                                  | 4     | todo   | T19      |
| T30 | UI: restore action                                                                                   | 4     | todo   | T20      |
| T31 | UI: workflow settings fields (max_child_depth, max_children_per_parent)                              | 4     | todo   | T2       |

phase gate: all unit + integration tests pass before advancing to next phase

---

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |
| —   | —           | —          | —               |

---

_spec is source of truth — update as decisions are made_
