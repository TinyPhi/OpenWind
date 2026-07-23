# ADR-006: Per-Workflow Ownership/Admin Model as a Second Authorization Path

**Status:** Accepted.  
**Date:** 2026-07-23.  
**Deciders:** Engineering lead, Platform architect.  
**Supersedes:** —  
**Related to:** ADR-001 (multitenancy/RLS), ADR-002 (workflow engine).  
**Superseded by:** —

---

## Context

### How this came up

PR #155 (`feat/PLAT-workflow-ownership-admin`, merged 2026-07-21) shipped a "per-workflow
ownership/admin model" — real, working, and already in use across ~25-28 files in `apps/api`,
`packages/workflow-engine`, and both frontend apps — without an ADR. `CLAUDE.md`'s 2026-07-22
doc-reconciliation entry flagged this explicitly: _"An ADR for the per-workflow ownership/admin
model — it's a second authorization path alongside RBAC... this is the kind of decision CLAUDE.md
reserves for a human-written ADR, and none exists yet."_ This ADR retroactively documents what
was built, the trade-offs it accepted, and the gaps it left open — it does not change any code.

Notably, migration `0035_workflow_created_by.sql` references `docs/specs/workflow-ownership-admin.md`
in its comment header — that spec file was never committed. This ADR is, in effect, the first
written record of the design.

### What shipped (confirmed by direct code read, not the PR title's claim)

**The mechanism.** `workflows` gained two columns (`packages/db/src/schema/workflow-engine.ts`):

```ts
createdBy: text("created_by"),        // Zitadel user ID; immutable after insert; always an implicit admin
assignedTo: text("assigned_to").array(), // Zitadel user IDs of designated workflow admins (includes creator)
```

The core predicate (`packages/workflow-engine/src/authorization.ts`):

```ts
export function isWorkflowAdmin(
  userId: string,
  workflow: { createdBy; assignedTo },
): boolean {
  return workflow.createdBy === userId || workflow.assignedTo.includes(userId);
}
```

**What it grants.** Being a workflow's creator or in its `assignedTo[]` grants the _same_ access
as the global `admin`/`agent` roles to **every `entity_instance` under that workflow** — read,
edit, comments, attachments, access-request approval, sub-ticket creation, listing, and
event/relation/transition history (`apps/api/src/lib/entity-access.ts`, `hasEntityAccess`) —
regardless of whether the workflow admin is personally that record's creator, assignee, or
`__accessUsers`-listed. The same predicate also gates workflow-_definition_ mutations
(add/update/delete state or transition, edit the workflow itself) via `assertWorkflowOwned`
(`packages/workflow-engine/src/workflow-crud.ts`), which 404s (not 403s) on a workflow the caller
doesn't own and isn't a global admin for.

**Why it exists.** Before this, a `user`-role caller who builds a workflow (e.g. a department
lead using the Phase 2D no-code workflow editor) had no way to manage records flowing through
_their own_ workflow unless they were personally each record's creator/assignee — or someone
granted them the global `agent`/`admin` role, which over-grants access to _every_ workflow in the
tenant. The ownership model is scoped, per-workflow delegation: "admin of this one workflow,"
without proliferating custom RBAC roles. This is consistent with the platform's existing stance
(`docs/specs/tender-management.md`: _"Global roles are `agent` and `admin` only... no custom
module roles exist"_) — the deliberate alternative to inventing new roles per use case.

**How it relates to RBAC.** It is a second, parallel path that _widens_ access, never narrows it.
The repeated pattern across ~20 route handlers:

```ts
let isPrivileged = roles.includes("admin") || roles.includes("agent");   // RBAC checked first
if (!isPrivileged) {
  const workflow = await getWorkflowByEntityTypeId(...);
  if (workflow && isWorkflowAdmin(userId, workflow)) isPrivileged = true; // ownership widens it
}
```

RBAC is checked first and short-circuits. If the caller lacks the global role, ownership is a
second gate that can still grant the same "privileged" outcome — but only for the workflows that
caller created or was assigned to, not tenant-wide.

**How it composes with the access-request/grant/revoke layer (PR #144).** Per-instance grants
live in `entity_instances.fields.__accessUsers` (a JSONB map of `userId → {level, tag}`), backed
by an `access_requests` table for the request/approve flow. Resolving an access request
(`apps/api/src/routes/entities/resolve-access-request.ts`) accepts three equally-valid approvers:
the record's own owner, a global admin/agent, **or** the workflow admin — the same three-way
composition used throughout. Direct grants (`grant-access.ts`, bypassing the request flow) are
the one inconsistency found during this review: they're gated `requireRole("admin", "agent")`
only — a workflow admin cannot directly grant access the way they can approve a _requested_ grant.
Worth resolving (see Open Questions), but not blocking this ADR.

### Known gap #1 — transition guards don't consult it (accepted "v1 limitation")

`docs/specs/tender-management.md` already documents this precisely:

> "Known engine gap: workflow transition guards (`packages/workflow-engine/src/engine.ts::executeTransition`)
> check `allowed_roles` against the actor's global roles only — they do NOT consult
> `__accessUsers`/per-instance grants. So "any agent or admin" can transition any tender in this
> module, not just the one assigned to it. Narrowing that would require an engine-level change
> (out of scope, see §C) — accepted as a v1 limitation, not fixed here."

Confirmed directly in `executeTransition`: its guard sequence (allowed roles → conditions →
requires-fields → requires-comment) never reads `instance.createdBy`/`assignedTo`/`__accessUsers`,
nor calls `isWorkflowAdmin`. `request.actorRoles` — global RBAC roles only — is the sole input to
the transition-time authorization decision. Ownership/ACL gating only decides whether a caller can
_reach_ the transition route at the API layer one level up; once inside the engine, it's role-only.
This is a real, documented, already-accepted scope boundary — this ADR does not propose closing it,
only makes it visible outside one module's spec file.

### Known gap #2 — no RLS on the tables this model protects

`workflows` and `entity_types` have a nullable `tenant_id` (NULL = system/template row, visible to
every tenant) but **no RLS policy at all**. `workflow_states`/`workflow_transitions` have no
`tenant_id` column whatsoever — reachable only via a join through `workflow_id`. Per
`.claude/rules/db-conventions.md`: _"Isolation on these four tables is enforced entirely by the
explicit ownership checks in `packages/workflow-engine` (`assertWorkflowOwned`/`visibleTo`) —
there is no RLS second layer for them yet."_ This means the ownership/admin model isn't only a
convenience feature — on these four tables, it is _also_ standing in for the tenant-isolation
guarantee every other tenant-scoped table gets from RLS as a second line of defense (ADR-001).
Tracked separately as **#136** ("Add RLS policies to entity_types / workflows / workflow_states /
workflow_transitions"), filed during the PR #135 review and still open. This ADR does not decide
the RLS policy shape (#136 itself proposes writing a follow-up ADR/addendum for that) — it flags
that the ownership model is presently load-bearing for isolation, not just convenience, so #136
carries more urgency than a generic hardening nice-to-have.

### Known gap #3 — `createWorkflow` doesn't check the entity type isn't already governed (found by adversarial review, tracked as #168)

An adversarial review of this ADR's own draft (2026-07-23) found a real, previously-undocumented
gap, independently verified against the code: `POST /workflows` is gated
`requireRole("admin", "agent", "user")` — any tenant member — and `createWorkflow`
(`packages/workflow-engine/src/workflow-crud.ts`) performs an unconditional `INSERT` with no check
that `input.entityTypeId` isn't already governed by an existing, legitimate workflow. There is no
DB-level uniqueness constraint on `workflows.entity_type_id`, and `getWorkflowByEntityTypeId` — the
resolver that both `list.ts` (unrestricted-listing decision) and `assertFieldWorkflowAccess`
(field add/edit/delete rights) rely on — does `SELECT ... LIMIT 1` with no `ORDER BY` when more
than one `workflows` row shares an `entity_type_id`. Net effect: a plain `user`-role tenant member
can `POST /workflows` against an entity type they have no relationship to, creating a shadow
workflow naming themselves admin; if that row is the one the undefined `LIMIT 1` resolution
returns, they gain unrestricted listing of every entity of that type and the ability to mutate its
field schema. This is unrelated to Known gaps #1/#2 above — it's a genuine authorization design
gap (an implicit, unenforced 1:1 entity-type↔workflow assumption), not a documented-and-accepted
trade-off. Filed as **#168**, not blocking this ADR's acceptance, but tracked with real urgency —
see Decision and Consequences below.

### Correction — "creator can never be removed from `assigned_to`" is narrower than first drafted

An earlier draft of this ADR stated this invariant unqualified. Adversarial review caught that
`workflow-crud.ts`'s guard against removing the creator from `assigned_to[]` is scoped
`!caller.isGlobalAdmin` — a global `admin` caller _can_ remove the creator; only non-admin callers
are blocked from doing so. The protection also has no database-level backing (migration `0035`'s
own comment notes it is "checked in code, not enforced by a FK") — purely an application-layer
guard. Corrected here rather than left as an overstated invariant.

### Security review already performed

A 2026-07-22 code-level review (`PROGRESS.md`) covered the access-request/grant/revoke surface
this model composes with and found it solid: tenant filters + RLS present on the tables that do
have RLS, 404-not-403 followed consistently, a double-approval race in `resolve-access-request`
already closed, no IDOR found. That review did not specifically stress-test the ownership model's
own blast radius — a follow-up adversarial pass on this ADR itself (2026-07-23) is what found
Known gap #3 above and the creator-removal overstatement, both independently verified against the
code, not inferred. Recommend the tracked follow-up (#168) get its own `/security-review` pass
when picked up, alongside the `updateWorkflow`/`grant-access.ts` items already noted.

---

## Decision

**Ratify the per-workflow ownership/admin model as an intentional, permanent platform
authorization primitive** — ownership (workflow `created_by`/`assigned_to[]`) is a legitimate,
scoped alternative to global RBAC roles, not a workaround or a bug. Specifically:

1. **The model stands as shipped.** A workflow's creator and its `assigned_to[]` members get
   full record-level access (read/write/comment/attach/approve-access/list/history) to every
   `entity_instance` under that workflow, equivalent to global `admin`/`agent`, without needing
   the tenant to grant those roles platform-wide.
2. **It composes with, and never narrows, RBAC.** Any future authorization check that reads
   `roles` must continue to check the global role allow-list first and treat ownership as an
   additive path, never a replacement or restriction.
3. **The transition-engine gap (Known gap #1) is explicitly accepted, not silently tolerated.**
   `executeTransition` remains role-only for now. If a module needs per-instance transition
   gating, the sanctioned path is extending `executeTransition` to consult `__accessUsers`/
   ownership as a new engine primitive (per ADR-004's escape-hatch rule) — not a module-level
   workaround.
4. **#136 (RLS on `entity_types`/`workflows`/`workflow_states`/`workflow_transitions`) is
   reclassified from generic hardening to a dependency of this model's integrity.** It should be
   scheduled with that framing, not left indefinitely deferred.
5. **`grant-access.ts`'s inconsistency (workflow admins can approve a _request_ but not issue a
   _direct_ grant) is noted as a follow-up, not fixed by this ADR.** See Resolved Decisions (WA-03).
6. **#168 (Known gap #3 — `createWorkflow` doesn't check the entity type isn't already governed)
   is accepted as a real, unresolved gap, tracked and prioritized, not blocking this ADR's
   acceptance.** Ratifying the ownership model does not mean ratifying this specific gap in how a
   workflow's governing relationship to an entity type gets established — that's a bug to fix, not
   a design trade-off to accept. See Consequences.

---

## Consequences

### Positive

- Lets a `user`-role caller manage the records flowing through a workflow they built, without
  granting them (or requiring an admin to grant them) tenant-wide `agent`/`admin` access — a
  materially smaller blast radius per person.
- Avoids proliferating bespoke module-specific roles (`tender-management.md`'s explicit stance):
  one general-purpose ownership primitive instead of N one-off role strings.
- Matches the config-first philosophy (ADR-004): access delegation is expressed as data
  (`created_by`/`assigned_to[]` rows), editable through the workflow builder UI, not code.

### Negative and mitigations

- **~25-28 file blast radius.** Any future change to `isWorkflowAdmin`'s semantics touches
  authorization across `packages/workflow-engine`, most of `apps/api/src/routes/entities/`, and
  both frontend apps. Mitigation: the predicate is centralized in one function
  (`packages/workflow-engine/src/authorization.ts`) precisely so semantic changes have one source
  of truth even though call sites are numerous.
- **Standing in for RLS on 4 tables (Known gap #2).** A bug in `assertWorkflowOwned`/`visibleTo`
  is not just an access-control bug on those tables — it's the _only_ isolation boundary they
  have. Mitigation: track as #136, prioritize before Phase 3 per the existing hardening
  checklist's own recommendation.
- **Transition-time gating gap (Known gap #1) means "workflow admin" isn't consulted at the one
  place with the highest state-mutation leverage** — any global `agent`/`admin` can transition
  any record in any workflow regardless of ownership, even though ownership gates most other
  record operations. Mitigation: accepted as v1 scope per `tender-management.md`; revisit if a
  module surfaces a concrete case where this matters (the sanctioned fix is an engine change, not
  a per-module hack).
- **`createWorkflow` doesn't verify the entity type isn't already governed by another workflow
  (Known gap #3).** A plain `user`-role tenant member can create a shadow workflow against an
  entity type they have no relationship to, and — because `workflows.entity_type_id` has no
  uniqueness constraint and `getWorkflowByEntityTypeId` resolves ties with an unordered
  `LIMIT 1` — potentially get treated as that entity type's workflow admin for listing and field
  mutation purposes. This is the most consequential finding from this ADR's own adversarial
  review. Mitigation: tracked as **#168**, filed same-day rather than delaying this ADR;
  recommend fixing before Phase 3A given the escalation potential.
- **No dedicated security review of the ownership model's own escalation surface.** Mitigation:
  recommend a follow-up `/security-review` pass specifically on `updateWorkflow`'s `assignedTo`
  edit guard and the `grant-access.ts` asymmetry noted above.

---

## Resolved Decisions (formerly Open Questions)

The four questions below were raised during drafting and resolved with the human decider on
2026-07-23. Each is settled as follows; none are still open.

**WA-01 — Should `executeTransition` be extended to consult `__accessUsers`/ownership at
transition time, closing Known gap #1?**
**Resolved: no, not now.** Role-only transition gating stands as **permanent, accepted policy**,
not a temporary gap — it matches ADR-004's escape-hatch philosophy (add an engine primitive only
when a concrete requirement demands it; none has). No tracked issue filed for this — the existing
`tender-management.md` v1-limitation language already documents the accepted boundary, and this
ADR is the second, platform-level place it's now recorded. Revisit only if a future module has a
concrete case that role-only gating actually blocks.

**WA-02 — Should #136's RLS policy design be its own ADR, or an addendum to this one?**
**Resolved: its own ADR (ADR-007, not yet drafted).** RLS policy shape for
`entity_types`/`workflows`/`workflow_states`/`workflow_transitions` requires real schema decisions
(adding `tenant_id` to `workflow_states`/`workflow_transitions`, or a subquery-based policy; how to
keep `tenant_id = NULL` system/template rows visible tenant-wide under RLS) — enough surface area
to deserve its own document, consistent with this repo's one-decision-per-ADR pattern (ADR-001 vs
ADR-002, etc.), rather than being buried as a subsection here. Recorded as a comment on #136 for
visibility. Whoever picks up #136 drafts ADR-007; recommend before Phase 3A per the existing
hardening-checklist ordering.

**WA-03 — Should `grant-access.ts` accept workflow-admin callers the same way
`resolve-access-request.ts` does?**
**Resolved: yes.** Filed as a small, low-risk follow-up (workflow admins already have equivalent-
to-`admin`/`agent` access on these records under this ADR's ratified model, so letting them
direct-grant too closes a consistency gap without creating new escalation surface). See the
tracked issue filed alongside this ADR.

**WA-04 — Should `docs/specs/workflow-ownership-admin.md` be written now, retroactively?**
**Resolved: yes.** Drafted alongside this ADR at `docs/specs/workflow-ownership-admin.md`,
referencing it, so migration `0035`'s dangling reference now points at a real document and the
spec/ADR/code triangle is complete.

**WA-05 — Should this ADR's acceptance be delayed until #168 (Known gap #3, found by this ADR's
own adversarial review) is fixed?**
**Resolved: no — proceed now, fix separately, tracked, not swept under anything.** The human
decider's explicit call: ratifying the ownership model as an architecture decision and fixing a
bug in how workflow↔entity-type governance gets established are separate concerns. Delaying this
ADR wouldn't make #168 get fixed any faster, and leaving the model undocumented while #168 is
worked is strictly worse than documenting it now with the gap tracked in the open. #168 is filed,
referenced from Known gap #3/Decision/Consequences above, and carries its own urgency
recommendation (before Phase 3A) independent of this ADR's acceptance timeline.
