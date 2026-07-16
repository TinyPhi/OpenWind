# User-Scoped Records & Workflow Records View

> Filter Records page and Workflow Records kanban to only what the calling user can access — parents via access list, children via child access list — for general (non-admin) users.

status: approved
created: 2026-07-02
updated: 2026-07-02

---

## §G Goal

General users see only tickets they are involved in.
Records page → workflow cards scoped to user.
Workflow records page → kanban scoped to user, with child tickets in sub-task sections.
Agents/admins see everything (no change to existing behaviour).

---

## §C Constraints

| constraint     | value                                                                                 |
| -------------- | ------------------------------------------------------------------------------------- |
| stack          | Hono API · Drizzle · PostgreSQL JSONB · React (Refine + shadcn/ui)                    |
| auth           | JWT claims carry `role` (`admin` \| `agent` \| `user`) and `userId`                   |
| access storage | `entity_instances.assigned_to`, `entity_instances.created_by`, `fields.__accessUsers` |
| child storage  | `entity_instances.fields.__parentId` links child to parent                            |
| out of scope   | Changing access grant/revoke logic (already implemented)                              |
| out of scope   | Child ticket workflow states — children have no workflow, only open/done status       |
| out of scope   | Admin/agent view changes — they continue to see all tickets unfiltered                |

---

## §I Interfaces

### New API endpoint

```
GET /api/entities/my-tickets?workflowId=<uuid>
```

Auth: `requireAuth()` — no role restriction (any authenticated user).

**Query params:**

| param      | required | description                               |
| ---------- | -------- | ----------------------------------------- |
| workflowId | no       | filter to a single workflow; omit for all |

**Response shape:**

```ts
{
  data: {
    workflows: Array<{
      workflowId: string;
      workflowName: string;
      workflowSlug: string;
      accessibleTicketCount: number; // parents + children
    }>;
    parentTickets: Array<{
      id: string;
      workflowId: string;
      currentState: string | null;
      fields: Record<string, unknown>;
      assignedTo: string | null;
      createdAt: string;
      accessReason: "creator" | "assigned" | "mention" | "manual";
    }>;
    childTickets: Array<{
      id: string;
      parentId: string;
      parentCurrentState: string | null; // inherited from parent for column placement
      workflowId: string;
      fields: Record<string, unknown>;
      assignedTo: string | null;
      createdAt: string;
      accessReason: "assigned" | "mention" | "manual";
    }>;
  }
}
```

### DB query logic (implementation-agnostic description)

A ticket is accessible to `userId` if ANY of:

- `created_by = userId`
- `assigned_to = userId`
- `fields->'__accessUsers'` contains key `userId`

A child ticket is accessible to `userId` by the same three checks on the child row itself (not the parent).

Child ticket's column placement = parent's `current_state` (join required).

---

## §R Requirements

### Records page

R1: General user sees only workflow cards where they have ≥1 accessible ticket (parent or child).
✓ User with no tickets in a workflow sees no card for that workflow.
✓ User with only a child ticket in a workflow sees a card for that workflow.
✓ Admin/agent still sees all workflow cards (role check gates the filter).

R2: Each workflow card shows count of accessible tickets (parents + accessible children).
✓ Count on card matches actual number of parent + child tickets in `my-tickets` response.

R3: Filter chips — All · Assigned to me · Watching · I created · Sub-tasks — filter which workflow cards are shown.
✓ Selecting "Assigned to me" hides workflow cards that have no assigned-to-me tickets.
✓ "All" chip shows full scoped set (no further filter beyond access list).
✓ Active chip persists in URL query param so page is shareable/refreshable.

### Workflow records page (kanban)

R4: General user sees only their accessible parent tickets in the transition columns.
✓ Ticket not in user's access list does not appear in any column.
✓ Admin/agent sees all tickets (unchanged).

R5: Each transition column has a "Sub-tasks" divider section below the parent ticket list.
✓ Sub-tasks section appears only when ≥1 accessible child ticket exists for that column's state.
✓ Sub-tasks section is hidden (not rendered) when count is zero — no empty divider.

R6: Child tickets appear in the same column as their parent's current state.
✓ If parent is in "In Progress", child appears in "In Progress" sub-tasks section.
✓ If parent is deleted/not accessible, child still appears under the state last known for the parent (via join on parent row).

R7: Child ticket card shows: title, own status chip (open/done), assignee avatar, direct link to child detail page.
✓ Clicking child card navigates to `/records/<entityTypeSlug>/<childId>`.
✓ Parent ticket is NOT shown on the child card (no ghost/stub).

R8: Filter chips from Records page carry into Workflow records page.
✓ Arriving via "Assigned to me" chip → workflow records pre-filtered to assigned tickets only.
✓ Sub-tasks section shows only sub-tasks matching active filter.

### Edge cases

R9: User has access to a child ticket but not the parent.
✓ Child still appears in sub-tasks section of the column matching parent's current state.
✓ Parent ticket card is NOT rendered (user has no access — no ghost card).

R10: Parent ticket is archived.
✓ Child ticket does not appear in any column (archived parent = no valid state bucket).

---

## §V Invariants

- General user NEVER sees a ticket (parent or child) they are not in the access list of.
- Admin/agent views are NEVER affected — no filtering applied when `role = admin | agent`.
- Child column placement is always derived from parent state, never from child's own state field.
- Sub-tasks divider is never rendered for an empty set — no "Sub-tasks (0)" sections.
- Workflow card count on Records page = sum of accessible parents + accessible children in that workflow.

---

## §T Tasks

| id  | task                                                                                     | phase | status | depends |
| --- | ---------------------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1  | API: `GET /entities/my-tickets` — query parent tickets by access list                    | 1     | todo   | —       |
| T2  | API: extend my-tickets to include child tickets with parent state join                   | 1     | todo   | T1      |
| T3  | API: roll up `workflows[]` summary array from parent+child results                       | 1     | todo   | T1, T2  |
| T4  | API: register route in entities index, add to OpenAPI types                              | 1     | todo   | T1, T2  |
| T5  | UI: Records page — fetch my-tickets (no workflowId), render scoped workflow cards        | 2     | todo   | T4      |
| T6  | UI: Records page — filter chips (All/Assigned/Watching/Created/Sub-tasks) with URL param | 2     | todo   | T5      |
| T7  | UI: Workflow records page — role-branch: admin/agent unchanged, user uses my-tickets     | 2     | todo   | T4      |
| T8  | UI: Workflow records page — render sub-tasks divider section per column                  | 2     | todo   | T7      |
| T9  | UI: child ticket card component (title, status chip, assignee avatar, direct link)       | 2     | todo   | T8      |
| T10 | UI: filter chips carry through from Records → Workflow records via URL param             | 2     | todo   | T6, T7  |
| T11 | Tests: unit tests for my-tickets query — access list variants, child join                | 3     | todo   | T1, T2  |
| T12 | Tests: integration test — cross-tenant isolation (user cannot see other tenant tickets)  | 3     | todo   | T1, T2  |

phase gate: all unit + integration tests pass before advancing to next phase

---

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |

---

_spec is source of truth — update as decisions are made_
