# ADR-021: Ticket Relations Taxonomy and Per-Ticket Participant Access

**Status:** Draft for peer review (drafted 2026-09-28 from docs/ticket-relations-design.md and shipped code; #620).  
**Date:** 2026-09-28.  
**Deciders:** Engineering Lead (acceptance pending). Review requested: @PrabhuVijit (#620).  
**Related to:** ADR-001 (multitenancy/RLS), ADR-002 (workflow engine — transition guards),
ADR-004 (config-first — relation behaviour is engine-owned, not module code), ADR-006 (per-workflow
ownership; Known gap #1: transition guards ignore `__accessUsers`), ADR-012 (third-party API —
Decision 5 mention resolution and auto-grant), ADR-016 (severity/labels — distinct from the
access-granting "tag" meaning used here).  
**Supersedes:** — (on acceptance, replaces `docs/ticket-relations-design.md` as the record of decision).  
**Superseded by:** —

**Reading note.** `docs/ticket-relations-design.md` (2026-06-26) proposed a typed relation taxonomy
and a new `ticket_participants` table. **`ticket_participants` does not exist**: no Drizzle table in
`packages/db/src/schema/` and no migration in `packages/db/migrations/` creates it (the name appears
only in the design doc and `docs/tracker/roadmap-tracker.md`). What shipped instead is the
`__accessUsers` per-instance ACL plus `access_requests`. This ADR records the shipped mechanism as
the decision and places the unbuilt design under Deferred Decisions.

---

## Context

### Problem — related work had no structure and no scoped access

Work split across agents produced unlinked tickets, with no hierarchy, no navigable
cross-references, and a binary access model (assignee, or tenant-wide admin/agent). The design doc
(§1, §4) proposed five relation pairs (`parent_of`/`child_of`, `blocks`/`blocked_by`,
`causes`/`caused_by`, `duplicates`/`duplicated_by`, `relates_to`) and a participant table with
`assignee`/`mentioned`/`watcher` roles (§7.5, §10.1).

### What shipped without an ADR

- Child tickets, access requests and a security pass: PR #144 (merged 2026-07-16). Automation
  `create_child` action: PR #343. Relation/linking fixes: PR #415. Third-party sub-ticket
  creation: PR #468 (ADR-012 Phase C).
- Storage: `entity_relations` (`packages/db/src/schema/entity-engine.ts`; created in migration
  `0000_initial_schema.sql`, soft-delete and partial active indexes in
  `0026_entity_relations_soft_delete.sql`). Per-workflow child limits: `workflows.max_child_depth`
  and `workflows.max_children_per_parent` (`0027_workflow_child_ticket_limits.sql`, CHECKs in
  `0033_child_ticket_limits_check.sql`). Access requests: `access_requests`
  (`0028_access_requests.sql`, grant in `0032`, `WITH CHECK` in `0048_rls_with_check.sql`, DELETE
  grant for erasure in `0126`). Mention auto-grant toggle: `workflows.allow_auto_grant_on_mention`
  (`0074_workflows_allow_auto_grant_on_mention.sql`).
- The design doc's prerequisite #121 (RLS role never set) is closed: `withTenantContext` runs
  `SET LOCAL ROLE app_user` (`packages/db/src/client.ts:29`). Its §2.2/§10.5 claim that RLS is
  unenforced is therefore stale.

---

## Decision

### Decision 1 — One generic `entity_relations` table; only two relation pairs carry engine semantics

All links are directed rows in `entity_relations` (`tenant_id`, `from_instance_id`,
`to_instance_id`, `relation_type TEXT`, `deleted_at`). The engine owns exactly two mirrored pairs:

- `parent_of` / `child_of` (`RELATION_PARENT_OF`/`RELATION_CHILD_OF`,
  `packages/entity-engine/src/child-relations.ts:36-37`) — hierarchy, Decisions 2–3.
- `references` / `referenced_by` (`RELATION_REFERENCES`/`RELATION_REFERENCED_BY`,
  `packages/entity-engine/src/entity-relations.ts:15-16`) — a bidirectional navigational link
  with no depth/cap/cycle validation and no workflow effect (`createReferenceLink`); it emits no
  outbox event, and either side can unlink on its own
  (`apps/api/tests/isolation/reference-links.isolation.test.ts`, R5/R6).

`POST /entities/:id/relations` (`apps/api/src/routes/entities/create-relation.ts`) stores
free-text `relationType` labels (1–100 characters) as a single, unmirrored row. `blocks`, `causes`,
`duplicates` and `relates_to` are not validated, not mirrored and not read by any code path; the
only occurrence of `"blocks"` is as sample data in `packages/entity-engine/src/entity-relations.test.ts`.
**Decision:** the typed taxonomy in design §4 is not adopted. Relation types other than the two
engine-owned pairs are opaque, informational labels with no access, lifecycle or transition effect.

**Not chosen (for now):** a closed enum or CHECK on `relation_type`. That would force a decision
on design §4's enforcement column that nobody has signed off (see Open Questions).

### Decision 2 — Hierarchy is created only via `createChildRelation`, under a row lock, with per-workflow limits

`createChildRelation` (`child-relations.ts:180`) inserts the child instance, its outbox events
and the `parent_of`+`child_of` pair in one transaction. It takes `SELECT … FOR UPDATE` on the
parent before checking limits (`child-relations.ts:216`). It checks, in order: the parent has a
workflow; `max_child_depth` is greater than 0 (0 means children are disabled); the chain depth
(`getAncestorDepth` + 1) is within `max_child_depth`; and the active child count is below
`max_children_per_parent`. Defaults are depth 1 and 10 children
(`packages/db/src/schema/workflow-engine.ts:31-35`). A caller may supply a stricter
`maxAncestorDepth`, which is checked under the same lock; the third-party API passes 1
(`apps/api/src/routes/third-party/children.ts:227`).

Re-parenting (`moveChildRelation`, `child-relations.ts:474`, `PATCH /:id/parent`, admin/agent
only) locks the child row. It soft-deletes the existing pair, which enforces one parent by
construction. It rejects self-parenting and descendants (`CHILD_CYCLE_DETECTED`) and re-checks
depth (ancestors + 1 + descendant depth) and the cap. Passing `newParentId = null` detaches the
child. Tests: `packages/entity-engine/src/child-relations.test.ts` (depth, cap, disabled, cycle,
self-parent). **This resolves design OQ-3 (depth 3 vs 5) differently from either option:** depth
is a per-workflow setting, bounded in code by `HARD_MAX = 20` on walks.
Design OQ-3 is therefore closed by this Decision rather than left open: a tenant that wants depth 3
or 5 sets `max_child_depth` on the workflow (ADR-004 config, no code), the `0033` CHECK bounds the
column, and the default of 1 keeps the flat case cheap.

### Decision 3 — Child tickets are lightweight units that share the parent's workflow

The design (§7.9) proposed children with no `workflow_id`. The shipped code gives each child the
parent's `workflow_id` (so comments and history resolve) with `current_state = 'open'` and a
binary `fields.child_status` of `open` or `closed` (`child-relations.ts:336-346`). Legacy children
with a null `workflow_id` resolve their workflow through the parent (`add-comment.ts`,
`entity-relations.ts` `resolveWorkflowContextForHistory`). `PATCH /:id/child-status` is
**admin/agent only**, and a plain owner is rejected
(`apps/api/src/routes/entities/set-child-status.ts:21`;
`child-ticket-routes.isolation.test.ts` H-3). This is stricter than design §7.9, which let the
assignee mark a child done. Child state never rolls up to the parent, matching design §5.

### Decision 4 — Access is a per-instance ACL in `entity_instances.fields.__accessUsers`, not a participant table

A ticket's access list is `createdBy` + `assignedTo` + the keys of `fields.__accessUsers`, a JSONB
map `userId → {level, tag}`. The levels are `read_only`, `read_comment` and `read_write`. The tags
are `mention`, `manual` and `assigned`, and `get-access.ts` synthesises `creator` for display. A
legacy `string[]` shape is still read as `read_comment`/`mention`
(`apps/api/src/routes/entities/get-access.ts`). The checks live in
`packages/workflow-engine/src/entity-access.ts`, re-exported by
`apps/api/src/lib/entity-access.ts`:

- `hasEntityReadAccess`: admin/agent role, creator, assignee, or any ACL level.
- `hasEntityCommentAccess`: the same, but `read_only` is insufficient.
- `hasEntityAccess` / `hasEntityCommentAccessFull`: add the ADR-006 workflow-admin fallback.

**Relations confer no access at check time.** None of these functions read `entity_relations`.
The only relation-derived access is copy-on-create: a new child's `__accessUsers` is the parent's
map (legacy arrays normalised first) with the child's assignee added as `read_write`/`assigned`,
which wins over a stale inherited entry (`child-relations.ts:295-333`, ADR-012 Phase C R9). After
creation the two lists drift independently. `canUserReadInstance` (assignee on any ancestor can
read a descendant) exists and is unit-tested but has no route caller
(`apps/api/src/routes/entities/list-children.ts:19` explains why it was not used).
`entity_instance_tags` (migration `0108`) are free-text labels and grant nothing.

**Not chosen (as shipped):** `ticket_participants` with `granted_by_event`, `revoked_at` and
`expires_at` (design §10.1). The JSONB ACL has no revocation history, expiry or provenance beyond
`tag`, plus the `workflow_events` access rows written by `emit-access-event`.

### Decision 5 — Four grant paths, all bounded to the ticket's tenant

1. **Direct grant** `POST /:id/access`: admin, agent or workflow admin (issue #167, closed). The
   target must exist in `tenant_users` for this tenant, or the route returns 404
   (`grant-access.ts`; `grant-access-workflow-admin.isolation.test.ts`).
2. **Request/approve** via `access_requests`: a partial unique index allows one pending request
   per user per ticket (`0028`). The approver is the owner, admin/agent or workflow admin
   (`resolve-access-request.ts`; `access-requests.isolation.test.ts`, which covers re-resolve and
   422).
3. **Human-UI @mention** (`add-comment.ts:205-440`): a mention grants access only when the
   commenter holds grant authority (admin/agent, creator/assignee, or workflow admin). The grant is
   synchronous (default level `read_comment`), tagged `mention`. There is no confirmation dialog.
4. **API @mention** (ADR-012 Decision 5): resolved asynchronously in
   `apps/worker/src/mention-resolution-worker.ts` to remove the timing side-channel. For a mentioned
   user who is known to the workflow but has no ticket access: if `allow_auto_grant_on_mention` is
   true (default false, `0074`), grant `read_only`/`mention`. Otherwise create an `access_requests`
   row. Auto-grants are capped at 5 per ticket per hour (`AUTO_GRANT_RATE_LIMIT`,
   `AUTO_GRANT_RATE_WINDOW_SECONDS`). Outcomes are audited as `tag.*` actions
   (`0076_admin_audit_log_tag_actions.sql`). No path grants transition rights (ADR-012 D5).

### Decision 6 — Tenant isolation: cross-tenant targets 404, and grants cannot widen across tenants

- Every relation query in `child-relations.ts`, `entity-relations.ts`, `archive.ts` and the
  route-level `child_of` walks (`get.ts`, `my-tickets.ts`, `add-comment.ts`) carries an explicit
  `tenant_id` filter.
- `createRelation` and `createReferenceLink` verify that both endpoints are in the caller's tenant
  and not soft-deleted. Otherwise they throw `RELATION_TARGET_NOT_FOUND`, which
  `handle-entity-error.ts:36` maps to **404**. Tested in
  `apps/api/tests/isolation/entity-engine.isolation.test.ts` ("createRelation — cross-tenant")
  and `reference-links.isolation.test.ts` (target in another tenant returns 404; deleting a link
  in another tenant returns 404; deleting a relation id belonging to a different ticket is
  rejected).
- RLS: `entity_relations` has `tenant_read`/`tenant_write` with `WITH CHECK`
  (`0001_rls_and_tenancy.sql` §5). `access_requests` has `access_requests_tenant_isolation`
  (`0028`, `WITH CHECK` in `0048`). Both are enforced under `app_user` (`client.ts:29`).
- Grants live on the tenant-scoped instance row itself, so an ACL entry can only affect tickets in
  that row's tenant. Every read re-selects the instance by `(id, tenant_id)`.
- Unauthorised callers get 404, not 403 (`get.ts`, `list-children.ts`, `grant-access.ts`,
  `resolve-access-request.ts`).

### Decision 7 — Archive cascades down the hierarchy with explicit confirmation; transitions ignore relations

`POST /:id/archive` (admin/agent) on a ticket with active descendants returns a
`requiresConfirm` prompt. With `?confirm=true`, the whole subtree and its relations are
soft-deleted, and pending alerts on every descendant are cancelled. Restore reverses the archive
by matching the archive timestamp (`packages/entity-engine/src/archive.ts`,
`apps/api/src/routes/entities/archive.ts`). This replaces design §10.3's "block, or force-delete
and orphan". No relation type affects `executeTransition`: `packages/workflow-engine/src/engine.ts`
never reads `entity_relations`. So `blocks` is advisory by absence, and ADR-006 Known gap #1
(guards ignore `__accessUsers`) still applies unchanged.

---

## Consequences

### Positive

- Hierarchy integrity (one parent, depth, cap, cycle) is enforced under row locks at the only two
  write paths that create or move hierarchy rows.
- The access check is a single row read with no graph walk, so tree size does not affect it.
- Tenant boundaries are enforced twice (explicit filter plus RLS as `app_user`), and every
  cross-tenant probe returns 404.
- API-driven escalation is off by default, rate-capped, async and audited (ADR-012 D5).

### Negative and mitigations

- **No provenance, expiry or revocation history on grants** (design §7.8, §9.2 "zombie access").
  Mention grants persist indefinitely. Mitigation: `GET /:id/access` lists every grant with its
  `tag`, grants and revokes write `workflow_events`, and `ticket_participants` stays deferred.
- **Inherited child access drifts from the parent.** Revoking on the parent does not revoke on
  children. Mitigation: none in code. Tracked as an Open Question.
- **A child assignee cannot read the parent** unless separately granted, so design §7.5 "ancestor
  read" is not delivered. This matches the Jira behaviour the design doc criticised (§3.1).
- **Relation-route and mention-grant validation is under a private review** (OQ-9).
  Mitigation: the outcome is recorded here when it closes.
- **JSONB ACL filtering** (`engine.ts:1428-1450`, `fields->'__accessUsers' ? userId`) has no
  expression index yet. The in-code comment already names the mitigation.

---

## Deferred Decisions

| Deferred item (designed, not shipped)                                                                                                                           | Trigger to revisit                                                    | Why deferred                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------- |
| `ticket_participants` table (roles, `granted_by_event`, `revoked_at`, `expires_at`), backfill from `assigned_to`, cutover and `assigned_to` drop (§10.1, §10.4) | Grant expiry/audit requirement, or ACL query cost                     | `__accessUsers` shipped first and covers current needs    |
| Watcher role and `POST`/`DELETE /entities/:id/follow`; `GET`/`POST`/`DELETE /entities/:id/participants[...]` (§7.5, §10.2)                                      | Participant table exists                                              | Depends on the table above                                |
| Freshdesk-style confirm dialog: `mentions[].has_access` in the comment response, then `POST …/participants/mention` (§7.4)                                      | Accidental-grant incident from UI mentions                            | UI mentions grant implicitly for grant-authority holders  |
| Typed taxonomy (`blocks`, `causes`, `duplicates`, `relates_to`) with inverse rows and lifecycle rules (§4)                                                      | First feature that consumes a non-hierarchy type                      | No consumer yet                                           |
| `blocks` cycle detection (DFS + lock on the blocked ticket) and a per-workflow `enforce_blocking` transition condition with audited override (§7.2, §7.7, §8.5) | Human decision on design OQ-2                                         | Requires an engine change (ADR-002 guard sequence)        |
| Ancestor-read derivation for child assignees, coordinator read via ancestors, revoke/re-derive on re-parent (§7.5, §9.5)                                        | Design OQ-1/OQ-8 decided                                              | Unused `canUserReadInstance` is the only artefact         |
| `duplicates` auto-resolve; god-ticket warning past 50 children; transitive-closure materialized view (§9.1, §10.7)                                              | Demand, or `max_children_per_parent` raised well above the default 10 | The default cap of 10 bounds the problem today            |
| Ancestor-chain notification relevance filtering, and link-only notification bodies (§7.4, §8.1)                                                                 | Notification-storm or privacy complaint                               | Not verified as implemented; out of this ADR's code scope |

---

## Open Questions

| ID    | Question                                                                                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-1  | Should a child assignee get read (or read + comment) on ancestors?                      | **Proposed:** no by default. If demand appears, add a per-workflow opt-in (`none` default, or `read_only`) that derives ancestor read at check time through the existing `canUserReadInstance`, not a copied grant. Why: least privilege matches ADR-006 role gating, and a workflow setting keeps it config-first (ADR-004), like `max_child_depth`. Jira and Linear avoid the question because project-level visibility covers sub-tasks. Record-ACL systems such as ServiceNow need an explicit rule, which is our position. A new column changes the schema contract. Needs human confirmation.                                                                                                             |
| OQ-2  | Should `blocks` be enforced at the transition layer or remain advisory?                 | **Proposed:** stay advisory. Enforce only as a per-workflow opt-in transition condition with an audited override, and only once `blocks` is typed (Deferred Decisions). Why: `engine.ts` reads no relations today (Decision 7), and a global rule would change ADR-002's guard sequence for every module. Jira, Linear and GitHub treat blocking links as informational unless a workflow condition is added. Needs human confirmation.                                                                                                                                                                                                                                                                         |
| OQ-4  | Should `duplicates` auto-resolve?                                                       | **Proposed:** no engine auto-resolve. If wanted, a module expresses it as an Automation Engine rule (ADR-004) once `duplicates` is typed. Why: closing a ticket is a workflow transition, which ADR-002 routes through guards and not relation side effects. Jira's "Duplicate" resolution is set by hand, and Zendesk closes only on an explicit merge. Needs human confirmation.                                                                                                                                                                                                                                                                                                                              |
| OQ-5  | How long should mention-granted access persist?                                         | **Proposed:** until revoked, as shipped. Revisit expiry only with `ticket_participants.expires_at` (Deferred Decisions), since the JSONB ACL has nowhere to store it. Why: Zendesk CCs and Jira watchers also persist, and `GET /:id/access` plus the `workflow_events` grant rows already let an owner or workflow admin audit and revoke. Needs human confirmation.                                                                                                                                                                                                                                                                                                                                           |
| OQ-6  | Should the watcher role be first-class?                                                 | **Proposed:** not before the participant table exists. When it lands, a watcher is a notification subscription only, never an access grant, so watching requires existing read access. Why: GitHub subscriptions and Jira watchers work this way, and it keeps every access path inside Decision 5's four gated grants (ADR-006). Needs human confirmation.                                                                                                                                                                                                                                                                                                                                                     |
| OQ-7  | What is the GDPR erasure policy for trees that mix sensitive and non-sensitive tickets? | **Proposed:** no tree-specific policy is needed for per-user erasure. It already works per ticket, whatever the tree shape: `user-erasure.ts` removes the user's key from every `__accessUsers` map (both map and legacy array shapes), nulls `created_by`/`assigned_to`, deletes the user's pending `access_requests`, and anonymises resolved ones and `resolved_by` (#688, PR #690). Tests: `user-erasure-coverage.isolation.test.ts`. `entity_relations` holds no user columns, so links survive intact. Content-level erasure of one sensitive ticket in a tree is record deletion, which archive (Decision 7) does not provide. Needs human confirmation on whether that belongs here or in ADR-015.      |
| OQ-8  | Should access propagation be synchronous or eventual?                                   | **Proposed:** keep the shipped split. Synchronous when the caller already holds grant authority (child copy-on-create, UI mention). Asynchronous only where ADR-012 D5's timing side-channel applies (API mention). Why: an eventual path would add a window in which a new child is unreadable by its own assignee, with no benefit. Needs human confirmation.                                                                                                                                                                                                                                                                                                                                                 |
| OQ-9  | Validation of the generic relation route and of UI mention grants.                      | Two within-tenant findings, tracked privately (no cross-tenant widening). Outcome to be recorded here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| OQ-10 | Should `entity_relations` get an RLS-only (GUC, no `WHERE`) isolation test?             | **Proposed:** yes. Add a "layer 2" block to `reference-links.isolation.test.ts`, modelled on `entity-instance-tags.isolation.test.ts:188-207`. With `app.tenant_id` set to tenant A under `app_user`, a `SELECT` on `entity_relations` with no `tenant_id` clause returns 0 of tenant B's rows (and the reverse). An `INSERT` whose `tenant_id` differs from the GUC is rejected by `tenant_write`'s `WITH CHECK` (`0001` §5). Why: the current relation tests (`entity-engine`, `reference-links`, `child-ticket-routes`) go through the engine's explicit filter, so they would still pass if the policy were dropped. The root `tests/isolation/` directory is empty. File via `pending-review-findings.md`. |
| OQ-11 | Should ADR-006 be updated?                                                              | **Proposed:** yes, with a one-line human-authored note. ADR-006's Context paragraph and Decision item 5 still say `grant-access.ts` is admin/agent only. WA-03 resolved "yes", #167 closed 2026-07-24 via PR #179, and the route now takes `requireRole("admin", "agent", "user")` plus an `isWorkflowAdmin` check (`grant-access.ts:21,55-66`; `grant-access-workflow-admin.isolation.test.ts`). ADRs are human-owned, so this ADR does not edit it. Needs human confirmation.                                                                                                                                                                                                                                 |

---

## Implementation status

- **Shipped:** Decisions 1–7 as described (PRs #144, #343, #415, #468 and ADR-012 Phase C).
- **Not shipped:** everything in Deferred Decisions, including `ticket_participants`.
- **On acceptance:** delete `docs/ticket-relations-design.md` and repoint
  `docs/specs/tender-management.md` to this ADR (#620 asks 3–4). Close OQ-9 through the private review, and
  file issues for OQ-10 and OQ-11 through `docs/reviews/pending-review-findings.md`.
