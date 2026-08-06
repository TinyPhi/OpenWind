# Open Workflow Visibility & Ticket Creation to All Tenant Users

> Any authenticated tenant user can see a workflow for ticket-creation purposes, create a
> ticket in its initial state, and assign it to a valid org "user" — without becoming a
> workflow admin. Workflow settings/config and the workflow-management list stay
> admin-gated. Post-creation record visibility is unchanged (creator/assignee/ACL only).

status: implemented
created: 2026-07-31
updated: 2026-08-05 (amended — see §C amendment note; PR #337 review)

---

> **Amendment (2026-08-05, PR #337 review):** the implementation widened the unscoped/bare
> `GET /workflows` call (no `entityTypeId`) to tenant-wide visibility for every caller, not just
> the `entityTypeId`-scoped ticket-creation-resolution path this spec originally scoped (§C had
> said the bare call "stays ownership-filtered"). This was flagged in review as a spec violation.
> On investigation it's a deliberate, necessary widening: `apps/admin-ui/src/pages/records/index.tsx`
> merges the bare `GET /workflows` result with `GET /entities/my-tickets` so a general user can
> discover and create the first ticket in a workflow they've never touched, not just ones they
> already own tickets in — restoring ownership-filtering on the bare call breaks that feature.
> Human-confirmed (Tushar Sharma, 2026-08-05): keep the tenant-wide bare-call behavior; this note
> is the sign-off. §C/R1 below are left as originally written for historical context, superseded
> by this note.

## §G Goal

A plain `user`-role tenant member can:

1. Discover which workflow governs a given entity type, in order to create a ticket.
2. Create a ticket in that workflow's initial state.
3. Assign that ticket to any valid `user`-role tenant member at creation time.

...without needing `isWorkflowAdmin` (createdBy/assignedTo[]) for any of the three. Workflow
definition mutation (PATCH/DELETE `/admin/workflows/:id`) and the ownership-filtered
workflow-management list stay exactly as gated today. Nothing about post-creation record
visibility (`hasEntityAccess` — creator/assignee/`__accessUsers` ACL/workflow-admin) changes.

---

## §C Constraints

| constraint    | value                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack         | Hono API · Drizzle · PostgreSQL · `packages/workflow-engine`, `packages/entity-engine`                                                                                                      |
| auth          | JWT claims: `role` (`admin`\|`agent`\|`user`), `userId`, `tenantId`                                                                                                                         |
| relevant ADR  | ADR-006 (per-workflow ownership model) — this change is additive, does not contradict it                                                                                                    |
| assignee pool | `role = "user"` tenant members only, reusing existing `GET /platform/users` filtering                                                                                                       |
| out of scope  | Workflow settings/config mutation (`PATCH`/`DELETE /admin/workflows/:id`) — stays admin-gated                                                                                               |
| out of scope  | Workflow-management list (unscoped `GET /workflows` used by the builder UI) — stays ownership-filtered                                                                                      |
| out of scope  | Broadening post-creation record visibility beyond today's `hasEntityAccess` model                                                                                                           |
| out of scope  | Transition-time authorization (ADR-006 Known gap #1 — role-only, accepted, not touched)                                                                                                     |
| out of scope  | `#168` (shadow-workflow creation gap) — separate, tracked issue, not this spec's concern                                                                                                    |
| out of scope  | Ticket-creation rate limiting — no new throttle added; existing per-tenant/per-user request limits (if any) are assumed sufficient. Revisit as a follow-up if abuse is observed post-launch |

---

## §I Interfaces

### 1. Workflow resolution for ticket creation

```
GET /workflows?entityTypeId=<uuid>
```

Current behaviour (`listWorkflowsSummary`, `packages/workflow-engine/src/workflow-crud.ts:208`):
non-global-admin callers filtered to `or(isNull(tenantId), ownedByCaller(caller))` — i.e. only
workflows the caller administers. This spec adds a distinct, narrower-purpose path so a plain
`user` can resolve "the workflow for entity type X" without seeing workflows they don't own in
any other context.

Two acceptable shapes — pick one during `/spec-tasks`, both satisfy §R1:

- (a) Drop the ownership filter from `listWorkflowsSummary` specifically when called with an
  `entityTypeId` filter (ticket-creation resolution only ever passes `entityTypeId`; the
  ownership-filtered call site — the workflow-management list — never does), **or**
- (b) Add a new function (e.g. `resolveWorkflowForEntityType`) used only by this route, leaving
  `listWorkflowsSummary` untouched for the unscoped/management-list caller.

**Do not touch `getWorkflowByEntityTypeId`.** This is a _separate_ function from
`listWorkflowsSummary`, also resolved by entity-type id, but it backs `assertFieldWorkflowAccess`
(workflow field-schema add/edit/delete rights — see ADR-006 Known gap #3). Whichever of (a)/(b)
is chosen, it must not merge, share, or refactor logic with `getWorkflowByEntityTypeId` — doing so
risks silently loosening field-schema edit rights alongside ticket-creation visibility, which is
not this spec's intent. Part of T1 is grepping every caller of the function actually changed to
confirm none of them expected ownership-filtering for a different purpose than ticket-creation
resolution.

Response shape unchanged (`WorkflowDefinition[]`) — id/name/entityTypeId is not new disclosure
per the existing precedent in `workflow-crud.ts`'s slug-resolution comment (entity-type discovery
is already tenant-wide via `GET /entity-types`).

If no workflow governs the given `entityTypeId`, the endpoint returns an empty array (`{ data: [] }`)
— not a 404 or error. This matches today's behaviour for an admin caller querying an ungoverned
entity type; opening the endpoint to `user`-role callers does not change that.

### 2. Ticket creation — `assignedTo` validation

```
POST /entities
{ entityTypeId, fields, assignedTo?, workflowId?, currentState? }
```

`assignedTo`, if present, must resolve to a real tenant member with `role = "user"` in the
caller's tenant — same pool `GET /platform/users` already exposes. Invalid/unknown/non-`user`-role
`assignedTo` → `422` with a field-level error, not a silent no-op or 500.

### 3. Records list filtering

```
GET /entities?entityTypeId=<uuid>&...
```

**This is a two-file fix, not one.** The actual scoping decision does not live in
`packages/entity-engine/src/engine.ts` alone:

- `apps/api/src/routes/entities/list.ts:64-81` computes `isPrivileged` (admin/agent/workflow-admin
  via `getWorkflowByEntityTypeId` + `isWorkflowAdmin` — see §I.1's invariant, this call site is a
  second, list-privilege-granting use of that function, distinct from field-schema access) and
  then **collapses the scope to a single value**: `const assignedTo = isPrivileged ?
rest.assignedTo : userId;` — only `assignedTo` is ever passed into `listEntities`.
- `ListEntitiesInput` (`packages/entity-engine/src/types.ts:108-117`) has no `createdBy`/ACL field
  at all; `engine.ts:868` only ever checks `input.assignedTo`.

Fixing only `engine.ts` ships a no-op: the route never passes it anything to work with. The fix
must:

1. Add a caller-scoping field to `ListEntitiesInput` (e.g. `scopeToUserId?: string`) that
   `engine.ts` turns into `createdBy = X OR assignedTo = X OR __accessUsers ? X`, replacing the
   current single-field `assignedTo` condition for the non-privileged path.
2. Update `list.ts` to pass `scopeToUserId: userId` for non-privileged callers instead of
   collapsing to `assignedTo: userId` — privileged callers (`isPrivileged === true`) keep passing
   `rest.assignedTo` through unchanged (that query param stays a real filter for admins/agents,
   not a scoping mechanism).
3. **Preserve the existing anti-bypass property exactly.** `list.ts`'s current comment — _"Non-
   privileged users are always scoped to their own records — query param cannot override"_ — must
   remain true bit-for-bit after this change: the new `scopeToUserId` value must be derived only
   from the authenticated `userId`, never from `rest.assignedTo` or any other query param, for a
   non-privileged caller. Getting this wrong reintroduces the exact class of bug this repo's own
   review checklist tracks as a query-param scoping bypass (PR #134 SEC-3) — here it would mean a
   non-privileged caller passing `?assignedTo=<someone-else>` regains the ability to read tickets
   they have no relationship to.
4. Reuse `apps/api/src/routes/entities/my-tickets.ts:65-69`'s existing three-way OR
   (`createdBy`/`assignedTo`/`fields->'__accessUsers' ? userId`) rather than re-deriving the SQL —
   it's already written, tested, and known-correct; matches `docs/specs/user-scoped-records-view.md`.

`__accessUsers` is stored in the `fields` JSONB column; an unindexed containment check inside
this `OR` risks a sequential scan on `entity_instances` for every non-privileged list call. Before
merging, run `EXPLAIN` on the new query shape against a representative row count and confirm it
doesn't regress; reuse whatever indexing the `my-tickets` endpoint already relies on rather than
introducing a second, unindexed path to the same data.

---

## §R Requirements

R1: Any authenticated tenant user can resolve the workflow governing a given entity type.
✓ `GET /workflows?entityTypeId=X` returns the workflow for a `role="user"` caller who is
neither the workflow's creator nor in `assignedTo[]`.
✓ The unscoped workflow-management list call (no `entityTypeId` filter, or the builder UI's
call site) is unchanged — still ownership-filtered for non-admins.
✓ `GET /workflows?entityTypeId=X` for an entity type with no governing workflow returns an
empty array, not a 404/error, for both privileged and `role="user"` callers.
✓ `getWorkflowByEntityTypeId` (the field-schema-edit-rights resolver) is unmodified by this
change — same function, same ownership-filtered behaviour, before and after.

R2: Any authenticated tenant user can create a ticket in a workflow's initial state.
✓ `POST /entities` with `role="user"` caller, valid `entityTypeId`, no `workflowId`/
`currentState` override → succeeds, `createdBy` defaults to caller (already true today —
regression-guard only).

R3: A ticket can be assigned at creation time to any valid `role="user"` tenant member.
✓ `POST /entities` with `assignedTo` = a real `role="user"` tenant member in the same tenant →
succeeds, ticket's `assignedTo` set.
✓ `POST /entities` with `assignedTo` = a nonexistent user id, an `agent`/`admin` account, or a
cross-tenant user id → `422`, ticket not created.

R4: Workflow settings/config remain admin-only.
✓ `PATCH /admin/workflows/:id` and `DELETE /admin/workflows/:id` still 404 for a `role="user"`
caller who is not the workflow's creator/assignedTo/global admin — unchanged from today.

R5: Users see their own created tickets in the records list, not just assigned ones.
✓ `GET /entities?entityTypeId=X` for a `role="user"` caller returns tickets where they are
`createdBy`, `assignedTo`, or hold an `__accessUsers` ACL grant — not `assignedTo` alone.
✓ Tickets where the caller has none of the above three relationships are excluded (no
broadening to "all tickets in a visible workflow").
✓ A non-privileged caller passing `?assignedTo=<another-user-id>` still cannot see that other
user's tickets — the query param is ignored for scoping purposes exactly as it is today,
regardless of which internal field carries the scoping value.

---

## §V Invariants

- Workflow _settings_ mutation (`PATCH`/`DELETE /admin/workflows/:id`) is gated by
  `isWorkflowAdmin` — never widened by this or any future ticket-creation-visibility change.
- The workflow-management list (used by the workflow builder UI) stays ownership-filtered for
  non-global-admin callers — ticket-creation resolution is a separate, narrower code path.
- `assignedTo` on any entity write is always validated against real tenant members with
  `role = "user"` — never accepted as an opaque string.
- Post-creation record visibility for non-privileged callers is exactly: `createdBy = caller`
  OR `assignedTo = caller` OR `__accessUsers` ACL grant present. No implicit "workflow is
  visible → all its records are visible" rule exists anywhere in the codebase.
- `getWorkflowByEntityTypeId` stays a distinct function from whatever ticket-creation's workflow
  resolution uses — the two are never merged or refactored to share logic. It has two existing
  call sites, both authorization-critical: `assertFieldWorkflowAccess` (field-schema edit rights)
  and `apps/api/src/routes/entities/list.ts` (grants full unrestricted-list `isPrivileged` status
  to a workflow admin) — neither is touched by this spec.
- `GET /entities`'s "query param cannot override scope" property holds regardless of which
  internal field(s) carry the scoping value — a non-privileged caller's effective scope is always
  derived from the authenticated `userId` alone, never from any request query parameter.

---

## §T Tasks

| id  | task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | phase | status | depends  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | -------- |
| T1  | Split/adjust workflow resolution (§I.1) so `entityTypeId`-scoped lookups aren't ownership-filtered, **with unit tests in the same commit**: R1's positive case, empty-array case, and a regression test proving `getWorkflowByEntityTypeId` + the unscoped management-list call are both unmodified                                                                                                                                                                                                                                                                                                 | 1     | done   | —        |
| T2  | Add `assignedTo` tenant-membership + role="user" validation to `POST /entities`, **with unit tests**: R3 positive case + all three R3 negative cases (nonexistent id, agent/admin account, cross-tenant id)                                                                                                                                                                                                                                                                                                                                                                                         | 1     | done   | —        |
| T3  | Fix `GET /entities` list filtering to include `createdBy` + `__accessUsers` ACL — **touches both** `packages/entity-engine/src/{types,engine}.ts` (new `scopeToUserId` field replacing the single-value non-privileged `assignedTo` path) **and** `apps/api/src/routes/entities/list.ts` (pass `scopeToUserId: userId` instead of collapsing to `assignedTo: userId`), **with unit tests**: R5 positive/negative cases, the query-param-cannot-override regression case, plus an `EXPLAIN`-based check that the new `OR` shape doesn't force a sequential scan (reuse `my-tickets`' indexing story) | 1     | done   | —        |
| T4  | Integration/isolation pass across T1–T3 together: R4 regression (`PATCH`/`DELETE /admin/workflows/:id` still 404 for non-owner `user`), R2 regression (ticket creation still defaults `createdBy` to caller), full R1–R5 cross-check                                                                                                                                                                                                                                                                                                                                                                | 2     | done   | T1,T2,T3 |
| T5  | `/security-review` — new surface: any tenant user can trigger workflow entry + assign to arbitrary `user`-role members (STRIDE notes below). See tasks doc's T5 evidence note (2026-08-05) for the actual review run and the `get.ts` regression it caught.                                                                                                                                                                                                                                                                                                                                         | 2     | done   | T4       |

R4 has no dedicated implementation task — no code change is needed, since `isWorkflowAdmin`
gating on `PATCH`/`DELETE /admin/workflows/:id` is untouched by this spec. It's verified as a
regression check in T4.

phase gate: all unit + integration + isolation tests pass before advancing to next phase

---

## STRIDE notes (new surface from this change)

Prior to this change, only workflow admins could create tickets in a workflow. After: any
tenant user can. New considerations, to be resolved during T5, not this draft:

- **Spoofing/Tampering:** `assignedTo` validation (R3) prevents assigning to a fabricated or
  cross-tenant user id — closes the main tampering vector this change opens.
- **Repudiation:** `createdBy` already defaults server-side to the authenticated caller
  (`create.ts`) and is not client-overridable in practice for non-privileged callers — confirm
  during review that a `role="user"` caller can't pass an arbitrary `createdBy` in the body.
- **Denial of Service (ticket-spam):** opening creation to all tenant users removes the implicit
  rate-limit of "only a few admins can create." Resolved as explicit out-of-scope (see §C) — no
  new throttle added in this spec; T5 confirms whatever per-tenant/per-user request limiting
  already exists (if any) still applies to this route unchanged.
- **Elevation of Privilege:** confirm the workflow-resolution change (T1) cannot be reused to
  leak `isWorkflowAdmin`-gated data (e.g. states/transitions/record counts) — `listWorkflowsSummary`
  already returns a lightweight shape without those; confirm the chosen T1 approach preserves that.
  Also confirm `getWorkflowByEntityTypeId` (field-schema-edit-rights resolver) is untouched — see
  §I.1 and R1's third criterion.
- **Inappropriate assignment:** R3's role="user"-only restriction prevents assigning tickets to
  `agent`/`admin` accounts (which could be read as an abuse vector — e.g. spamming an agent's
  queue) — already scoped out by design, confirm test coverage (T2/T4) exercises it explicitly.

---

## §B Bugs / Backprop Log

| id  | what failed                                                                | root cause                                                              | promoted to §V? |
| --- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------- |
| —   | (pre-existing) users couldn't see their own created-but-unassigned tickets | `GET /entities` filtered by `assignedTo` only, no `createdBy`/ACL check | yes — see §V    |

---

_spec is source of truth — update as decisions are made_
