# Third-Party API — List My Tickets

> `GET /workflows/:id/tickets` — lets an acting person list "their own" tickets on a workflow
> (creator, assignee, or access-granted), mirroring the internal records page's `scopeToUserId`
> mechanism exactly. Closes the real gap that the comment flow's ticket-lookup step otherwise
> has no way to discover a ticket ID without the caller already having recorded it themselves.

status: implemented
created: 2026-08-28
updated: 2026-08-28

---

## §G Goal

A third-party caller can list the tickets on a given workflow that the acting person can see —
same three-way access rule the internal records page already uses (creator OR assignee OR
`__accessUsers` grant), plus full unrestricted visibility if the acting person is that workflow's
admin — without needing any ticket ID known in advance.

---

## §C Constraints

| constraint      | value                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack           | `apps/api` (Hono third-party route), reuses `packages/entity-engine`'s existing `listEntities` (with `scopeToUserId`) and `packages/workflow-engine`'s `getWorkflow`/`isWorkflowAdmin` — no new package                                                                                                                                                                                                                           |
| auth            | Identical dual-identity flow to every other third-party route — `entity:ticket:read` (no new scope verb; `TICKET_ACTION_VERBS` is a fixed enum and adding to it is a separate, human scope decision, not made here)                                                                                                                                                                                                               |
| access model    | Mirrors the internal records page (`apps/api/src/routes/entities/list.ts`) exactly: `scopeToUserId = actingPersonId` (creator OR assignee OR `__accessUsers` key-exists) UNLESS the acting person is the workflow's admin, in which case the scope filter is dropped entirely (full visibility) — same all-or-nothing bypass shape `list.ts` already uses, not a per-row OR condition                                             |
| list/get parity | `listEntities`'s `scopeToUserId` matches an `__accessUsers` grant by key-existence alone, regardless of its `level` — looser than `hasEntityAccess`'s check (used by `GET /tickets/:id`), which additionally requires `level` to be `read_only`/`read_comment`/`read_write`. Without reconciling this, a ticket could appear in this list and then 404 when opened via `GET /tickets/:id` — see R1's fourth criterion for the fix |
| rate limit      | Identical rate-limit middleware chain as every other third-party route (`requireTicketScope`) — see R7                                                                                                                                                                                                                                                                                                                            |
| pagination      | Cursor-based (opaque, `{createdAt, id}`-encoded), matching `listEntities`'s existing shape exactly — NOT the limit/offset shape `GET /workflows` uses, since this endpoint is a direct mirror of the internal records page, not of `GET /workflows`                                                                                                                                                                               |
| redaction       | Every returned ticket's `pii`/`financial` fields are redacted exactly as `GET /tickets/:id` already redacts them (`redactEntityFieldsForThirdParty`) — the sensitivity map is computed once per page (entity-type-invariant across the page), not once per row                                                                                                                                                                    |
| out of scope    | Any new `entity:ticket:*` scope verb — reuses `read`                                                                                                                                                                                                                                                                                                                                                                              |
| out of scope    | Filtering by fields other than `state` (no arbitrary `fieldFilters` passthrough — internal callers get that via `list.ts`, third-party callers do not, to avoid exposing an unbounded query surface)                                                                                                                                                                                                                              |
| out of scope    | `rootOnly`/`includeDeleted` passthrough — always root tickets, never soft-deleted, same default a third-party caller should expect from every other read endpoint                                                                                                                                                                                                                                                                 |
| out of scope    | Changing `GET /tickets/:id`'s own behavior, or any other existing route — purely additive                                                                                                                                                                                                                                                                                                                                         |
| perf note       | `listEntities`'s `__accessUsers` ACL branch is a linear scan, not index-assisted (accepted internally at `list.ts`'s own measured scale) — this endpoint reaches the identical code path, now from an external caller, behind the same rate limits as everything else; no new invariant needed, just recorded here for awareness                                                                                                  |

---

## §I Interfaces

**Route:** `GET /api/v1/workflows/:workflowId/tickets?state=<optional>&limit=<optional>&cursor=<optional>`

Resolves `workflowId` → `entityTypeId` internally (same pattern as
`docs/specs/third-party-api-workflow-fields-schema.md`'s endpoint), then calls `listEntities`
scoped to the acting person (or unscoped, if they're the workflow's admin).

**Query params:**

- `state` (optional) — filter to one workflow state
- `limit` (optional, default 50, max 100 — matches `listEntities`'s own `MAX_PAGE_SIZE`)
- `cursor` (optional) — opaque pagination cursor from a previous page's `nextCursor`

**Response — 200:**

```json
{
  "data": [
    {
      "id": "30d256cb-80b2-46a8-8bf5-57199c9b442b",
      "entityTypeId": "3c199154-9340-4642-b7a6-700ef3016110",
      "workflowId": "5298ff3d-79c8-43bf-8c45-ef38760c54a8",
      "currentState": "draft",
      "fields": { "title": "Client dinner", "amount": "[REDACTED]" },
      "createdBy": "378676050449661954",
      "assignedTo": null,
      "createdAt": "2026-08-28T00:27:31.327Z",
      "updatedAt": "2026-08-28T00:27:31.327Z"
    }
  ],
  "nextCursor": "eyJjcmVhdGVkQXQiOiIyMDI2LTA4LTI4VDAwOjI3OjMxLjMyN1oiLCJpZCI6IjMwZDI1NmNiLTgwYjItNDZhOC04YmY1LTU3MTk5YzhiNDQyYiJ9"
}
```

- `nextCursor` is `null` when there are no more pages — pass the previous non-null value back as
  `?cursor=` to get the next page.
- Field shape/redaction is otherwise identical to `GET /tickets/:id`'s response.

**Errors:**

- `404 NOT_FOUND` — workflow doesn't exist, or belongs to another tenant (same existence-oracle
  convention as `GET /workflows/:id/fields`)
- `403 FORBIDDEN` — key lacks `entity:ticket:read`
- `401 UNAUTHORIZED` — missing/invalid/stale auth
- `400 VALIDATION_ERROR` — `limit` out of range, or a malformed `cursor` (matches `GET /workflows`'s
  own query-param validation status via the shared `zValidator` — 422 is reserved for request-BODY
  field-schema/business-rule failures elsewhere in this API, not query-param shape)

---

## §R Requirements

R1: A caller with `entity:ticket:read` gets every ticket on the given workflow that the acting
person is the creator of, assignee of, or holds an `__accessUsers` grant on.
✓ A ticket where the acting person is creator appears in the results.
✓ A ticket where the acting person is assignee (but not creator) appears in the results.
✓ A ticket where the acting person holds an `__accessUsers` grant at `read_only`, `read_comment`,
or `read_write` level appears in the results.
✓ A ticket with none of the above relationships to the acting person does NOT appear, even if it
exists on the same workflow.
✓ **List/get parity**: a ticket that would NOT pass `hasEntityAccess` (e.g. an `__accessUsers`
grant with a level outside the three recognized values) is filtered out of this endpoint's
results even though `listEntities`'s own `scopeToUserId` SQL would otherwise include it —
implemented as a post-filter over the page (bounded by `limit`, cheap in-memory check) so a
ticket never appears in this list only to 404 when the caller opens it via `GET /tickets/:id`.

R2: A workflow-admin acting person sees every ticket on that workflow, unscoped.
✓ A ticket where the workflow-admin acting person has NO creator/assignee/ACL relationship still
appears in the results, when that person is the workflow's admin.

R3: Pagination is cursor-based and matches `listEntities`'s existing contract exactly.
✓ A page smaller than the total result set returns a non-null `nextCursor`.
✓ Passing that `nextCursor` back as `?cursor=` returns the next page, with no duplicate or
skipped rows across the two pages.
✓ The last page returns `nextCursor: null`.
✓ `limit` defaults to 50, rejects (400) values over 100.
✓ A malformed/undecodable `cursor` value returns `400 VALIDATION_ERROR`, never a 500 or a silent
fallback to page 1.
✓ `nextCursor` is always derived from `listEntities`'s own pre-filter batch position, never
recomputed from the post-filter (R1's list/get-parity filter) result count — so the ACL-level
reconciliation filter changes page CONTENTS, never page BOUNDARIES (no skipped/duplicated rows
across pages as a side effect of filtering).

R4: Sensitive fields are redacted identically to `GET /tickets/:id`.
✓ A `pii`/`financial` field on any returned ticket shows `"[REDACTED]"`, not its real value.
✓ The redaction is computed once per page, not once per row (a performance/correctness
invariant — see §V).

R5: Access control otherwise matches every other third-party route.
✓ Cross-tenant or nonexistent workflow ID → 404.
✓ Key lacking `entity:ticket:read` → 403.
✓ Missing/invalid/stale auth → 401.
✓ A page never includes a ticket belonging to a different tenant, even under an entity-type-id
collision across tenants (belt-and-suspenders — `listEntities` already filters by `tenant_id`,
this is a direct isolation test of this endpoint specifically, not a re-test of `listEntities`).

R6: This endpoint is purely additive.
✓ `GET /tickets/:id`, `GET /workflows`, and `GET /workflows/:id/fields` are all unaffected.

R7: This endpoint sits behind the identical rate-limiting middleware chain as every other
third-party route.
✓ All 3 ADR-013 tiers (per-tenant, per-key, per-key-and-person) apply — verified by an isolation
test confirming the standard `x-ratelimit-key-person-*` headers are present on a successful
response.

---

## §V Invariants

- The scoping filter (creator/assignee/`__accessUsers`) is ALWAYS derived from the
  server-resolved `actingPersonId` — never from a request query parameter (same invariant
  `list.ts`'s own doc comment states for the internal route).
- Workflow-admin visibility is an all-or-nothing bypass of the scope filter, not folded into the
  per-row OR condition — matching `list.ts`'s existing shape exactly, so a future change to one
  doesn't silently diverge from the other.
- The redaction sensitivity map is computed once per page load, never once per row — this is
  both a performance invariant and a correctness one (a per-row DB query for the same
  `entityTypeId`'s sensitivity map would be wasteful, but computing it inconsistently per row
  would also risk drift within a single response).
- A ticket visible via this list endpoint is ALWAYS also visible via `GET /tickets/:id` for the
  same acting person — the list/get-parity post-filter (R1) exists specifically to guarantee
  this; no future change to either endpoint's access check should reintroduce the gap without
  updating the other.
- Pagination cursor boundaries are computed from the pre-filter batch, never the post-filter
  result — filtering changes what's shown, never where the next page starts.
- Cursor comparisons and their ORDER BY must always operate at the SAME timestamp precision the
  cursor's own encoding can represent (millisecond, via `date_trunc('milliseconds', ...)` in
  `listEntities`) — comparing a full-microsecond-precision column against a millisecond-truncated
  cursor value causes the pivot row to duplicate across page boundaries (found as B1; this
  invariant exists so a future change to either the encode/decode side or the SQL comparison side
  doesn't silently reintroduce the mismatch).

---

## §T Tasks

| id  | task                                                                                                                                                                                                                                                                                                                                       | phase | status | depends     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ------ | ----------- |
| T1  | Add `GET /workflows/:workflowId/tickets` route — resolve workflow → entityTypeId, resolve workflow-admin status, call `listEntities` with `scopeToUserId` (or unscoped if admin)                                                                                                                                                           | 1     | done   | —           |
| T2  | Wire dual-identity auth + `entity:ticket:read` scope + standard rate-limit middleware, identical pattern to sibling routes (R7)                                                                                                                                                                                                            | 1     | done   | T1          |
| T3  | Apply redaction once per page (hoist `entity_fields`/sensitivity-map lookup out of the per-row loop) per §V                                                                                                                                                                                                                                | 1     | done   | T1          |
| T4  | Shape the response per §I — `data`/`nextCursor`, `state`/`limit`/`cursor` query params, 400 on invalid `limit`/malformed `cursor` (R3, corrected from 422 per B2)                                                                                                                                                                          | 1     | done   | T1          |
| T5  | List/get-parity post-filter (R1's 4th criterion) — drop any row from the fetched page whose only access path is an `__accessUsers` grant with a non-standard `level`, without shifting the pagination cursor boundary (§V)                                                                                                                 | 1     | done   | T1          |
| T6  | Isolation tests: creator/assignee/ACL-grant visibility, non-related-ticket exclusion, workflow-admin full visibility, list/get parity (R1's 4th criterion), pagination (2+ pages, no dupes/gaps, malformed-cursor 400), redaction, tenant isolation, cross-tenant/nonexistent 404, missing-scope 403, invalid auth 401, rate-limit headers | 1     | done   | T2,T3,T4,T5 |
| T7  | Regression check: existing `GET /tickets/:id`, `GET /workflows`, `GET /workflows/:id/fields` suites still pass unmodified, PLUS the full `entity-engine`/`workflow-engine` suites (B1's shared-code pagination fix)                                                                                                                        | 1     | done   | T6          |
| T8  | Update the partner-facing API reference doc with the new endpoint                                                                                                                                                                                                                                                                          | 2     | done   | T7          |
| T9  | Wire OWTesterUI's comment flow to call this instead of requiring a manually-pasted ticket ID (follow-up, separate PR, outside this repo)                                                                                                                                                                                                   | 2     | todo   | T7          |

phase gate: all unit + isolation tests pass

---

## §B Bugs / Backprop Log

| id  | what failed                                                                                            | root cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | promoted to §V?                                      |
| --- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| B1  | Cursor pagination duplicated the pivot row across page boundaries (found by T6's pagination test)      | `packages/entity-engine`'s cursor compared the raw `entity_instances.createdAt` (Postgres `timestamptz`, microsecond precision) against a cursor value round-tripped through a JS `Date`/`.toISOString()` (millisecond precision only) — the pivot row's own nonzero microsecond remainder made it satisfy `gt(actual, truncated)` against itself. Pre-existing bug in shared code (also affects the internal records page, `apps/api/src/routes/entities/list.ts`), not introduced by this feature. Fixed by truncating both the WHERE-clause comparison and the ORDER BY to the same millisecond precision the cursor can represent (`date_trunc('milliseconds', ...)`), in `packages/entity-engine/src/engine.ts`'s `listEntities`. | yes — see §V's new pagination-precision invariant    |
| B2  | Spec assumed `422 VALIDATION_ERROR` for invalid `limit`/malformed `cursor`, without checking precedent | The existing `GET /workflows` route already validates its own `limit`/`offset` query params via the shared `zValidator` wrapper, which returns `400`, not `422` (422 is reserved for request-BODY field-schema/business-rule failures per `code-style.md`'s HTTP-semantics table). Spec updated to `400` for consistency; caught during implementation, before merge.                                                                                                                                                                                                                                                                                                                                                                  | no — a spec-accuracy correction, not a new invariant |

---

_spec is source of truth — update as decisions are made_
