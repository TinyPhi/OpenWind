# Team-Assign at Ticket Creation + On-Call Fallback to Workflow Admin

> Ticket creation gets a User/Team assign-mode toggle; team_id starts real (seeded field), and
> resolve_oncall's cascade gains a workflow-admin final tier + one summarizing system comment.

status: draft
created: 2026-09-21
updated: 2026-09-21

---

## §G Goal

A ticket creator picks exactly one of **User** or **Team** as the assignee at creation. Team
picks resolve async (existing `entity.created` -> `resolve_oncall` pipeline) to primary ->
backup -> escalation -> (new) workflow-admin, fail-open only if all four are unresolvable. One
system comment lands on the ticket summarizing the outcome.

## §C Constraints

| constraint   | value                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack        | Hono API, Drizzle, React/Refine admin-ui, BullMQ worker (automation-engine)                                                                                                                                                                                                                                                                                                                                                  |
| auth         | unchanged — existing tenant/role checks on `/entities` POST                                                                                                                                                                                                                                                                                                                                                                  |
| dep graph    | automation-engine -> db, workflow-engine, entity-engine, teams, audit (already allows this)                                                                                                                                                                                                                                                                                                                                  |
| async model  | resolution stays event-driven (`entity.created` outbox -> worker), NOT synchronous at create                                                                                                                                                                                                                                                                                                                                 |
| scope        | all workflows/tenants platform-wide; team dropdown = all teams in tenant, no service scoping                                                                                                                                                                                                                                                                                                                                 |
| out of scope | recurring schedules, DST handling, service-to-workflow team scoping, sync resolution, verifying the resolved workflow-admin user is still active/exists in Zitadel (same trust level as existing primary/backup/escalation resolution — none of those verify liveness either), retroactively changing tickets created before this ships (this is a create-time-only feature; pre-existing tickets are unaffected either way) |

## §I Interfaces

**`entity_instances` / `POST /entities` (apps/api/src/routes/entities/create.ts):**
`CreateEntitySchema` today requires `assignedTo` unconditionally. New shape:
`assignedTo: z.string().min(1).optional()`, `teamId: z.string().min(1).optional()`, refined so
exactly one of the two is present (`.superRefine`, mirrors existing remark/dueDate mandatory
pattern already in this file). `teamId`, when present, is written into `fields.team_id` (same
JSONB slot `resolve-oncall.ts` already reads) — not a new `entity_instances` column, consistent
with how `resolve-oncall.ts`'s own code comment describes the existing (currently dormant) rule.

**`title` auto-seed precedent (`packages/entity-engine/src/entity-types.ts::createEntityType`):**
same pattern reused to seed `team_id` as a real (but NOT required) entity field on every
per-tenant entity type — `isRequired: false`, `fieldType` a reference/select type resolving to
`teams.id` (reuse whatever `entity_ref`-style config the platform already has for FK-like custom
fields; confirm exact fieldType during T1).

**`resolveOncallCascade` (`packages/teams/src/oncall-resolver.ts`):** extend `CascadeResult`'s
`tier` union with `"workflow_admin"`; extend the `candidates` array with a 4th entry resolved by
the caller (`resolve-oncall.ts`), not inside `oncall-resolver.ts` itself, since workflow lookup
needs `workflow-engine`/`db`, which `packages/teams` (db-only per dependency rule) cannot import.
Concretely: `resolve-oncall.ts` calls `resolveOncallCascade` first; if it returns `{tier: null}`,
falls back to a new local helper that reads the ticket's workflow (`workflows` row via
`entity_types.id` -> `workflows.entity_type_id`) and returns `workflows.createdBy` if present.

**New system-comment helper in automation-engine** (no existing one is importable — apps/api's
`post-system-comment.ts`/`post-remark-comment.ts` live outside automation-engine's allowed
dependency set): a small local helper in `packages/automation-engine/src/actions/resolve-oncall.ts`
(or a new sibling file) that inserts directly into `workflowEvents`
(type `"comment"`, `actorId: "system"`) + `outboxEvents` ("comment.created"), matching the shape
apps/api's two existing comment-posting helpers already establish — do not diverge on schema.

## §R Requirements

R1: Ticket creator picks exactly one of User or Team when creating a ticket, on both creation
forms (`record-create.tsx`, `instance-create.tsx`).
✓ Submitting with neither selected blocks submit client-side with an inline error, mirroring the
existing assignedTo/dueDate/remark guard already in both files.
✓ Submitting with both selected is prevented by the UI (radio/segmented toggle, not two
independently-fillable fields).
✓ Server rejects (422) a request with neither or both of `assignedTo`/`teamId` set, even if the
client-side guard is bypassed.

R2: Every per-tenant workflow has a real (optional) `team_id` field available from creation
onward, and that field is never shown or editable as a generic custom field.
✓ Every entity type created after this change has `team_id` available as a field at creation
time, with no separate admin action needed to add it.
✓ All 12 dev-tenant workflows that existed before this change have a `team_id` field present
once this ships, verifiable by querying `entity_fields` for each of their entity types.
✓ `team_id` never appears in the "Other" tab's generic custom-field list on either creation form
— it is exclusively set through the new User/Team assign-mode toggle (R1), never independently
editable as a normal custom field. (Resolves the field-visibility conflict flagged in
spec-review: showing it twice, once via the toggle and once as an editable Other-tab field,
would let the two fall out of sync.)
✓ The previously-dormant seeded `entity.created`/`entity.updated` `resolve_oncall` automation
rules (`modules/helpdesk/seed/003_automation_rules.sql`) now actually fire when `team_id` is
set, since the field exists.

R3: When a ticket is created with `teamId` set (no explicit `assignedTo`), the on-call cascade
resolves and assigns the ticket exactly once, asynchronously.
✓ Same async model as today — resolution happens after creation via the outbox/worker path, not
inline in the POST /entities response.
✓ Idempotency (`oncall_resolve:{instanceId}:{teamId}` Redis NX key) is preserved unchanged.
✓ Explicit-assignee-wins behavior is unaffected — this requirement only applies when `assignedTo`
was NOT set at creation (which R1's exactly-one-of constraint already guarantees for the
team-mode path).

R4: The on-call cascade gains a 4th, final fallback tier: the ticket's workflow admin. This tier
is checked whenever the existing schedule-based cascade produces no assignee, from EITHER of its
two existing fail-open exits — not only the "cascade exhausted" one.
✓ Cascade order: primary -> backup -> escalation manager -> workflow admin.
✓ The workflow-admin tier fires when there is no active schedule for the team at all (today's
`getActiveScheduleForTeam` returning null — the more common real-world gap, e.g. a team with no
schedule configured yet), AND when a schedule exists but every populated tier in it is
unresolvable (today's `resolveOncallCascade` returning `{tier: null}`). Both are "the cascade
produced nobody" and both now fall through to the same workflow-admin check.
✓ "Workflow admin" resolves to `workflows.createdBy` for the workflow governing the ticket's
entity type (ADR-006 — creator is always the implicit admin; "first found" per user decision,
no need to consult `assignedTo[]` when `createdBy` is always populated).
✓ If the ticket's entity type has no governing workflow row, or that workflow has no
`createdBy`, the cascade is exhausted and behaves exactly like today's fail-open path
(`oncall.no_schedule` audit + coverage-gap Redis set) — no crash, no silent unassigned ticket
with no trace.
✓ A ticket auto-assigned to the workflow-admin fallback is audited with a distinguishable
`assignedTier: "workflow_admin"` value in the existing `oncall.auto_assigned` audit metadata.

**Accepted, pre-existing risk (not fixed by this spec):** workflow lookup uses
`getWorkflowByEntityTypeId`, which has a known, already-tracked ordering gap when more than one
`workflows` row governs the same `entity_type_id` (ADR-006 Known gap #3 / issue #168 — unordered
`LIMIT 1`). This spec's workflow-admin fallback inherits that risk as-is: in the rare case of
duplicate workflow governance, the fallback could resolve to the wrong workflow's creator. Not
blocking this spec — #168 is independently tracked — but recorded here rather than left invisible.
If #168 is fixed first, this fallback benefits automatically with no code change on this spec's
side.

R5: Exactly one system comment is posted on the ticket once resolution completes (success or
fail-open), summarizing the outcome.
✓ Comment text names which tier was ultimately assigned to (or that no coverage existed at all,
for the fail-open case).
✓ When the assigned tier is NOT primary, the comment includes a one-line reason (which earlier
tiers were unresolvable) — e.g. "No primary/backup/escalation coverage found for team X —
auto-assigned to workflow admin Y."
✓ Fail-open case (no tier resolved at all, including the new workflow-admin tier) also gets its
one comment: "No on-call coverage configured for team X, and no workflow admin could be
resolved — ticket left unassigned." — same single-comment guarantee applies here too, not just
the success path.
✓ Exactly one comment per (instanceId, teamId) resolution — reuses the same idempotency key
already guarding the rest of the action, so a retried/replayed event does not double-post.
✓ Comment is attributed to "system" (actorId: "system"), same convention as other automation
audit-adjacent comments in this codebase.

## §V Invariants

- Exactly one of `assignedTo`/`teamId` is ever set on a `POST /entities` request — enforced
  server-side regardless of client behavior (never trust the toggle UI alone).
- `resolve_oncall`'s idempotency key continues to gate ALL of the action's side effects for a
  given (instanceId, teamId) pair, including the new comment — a re-delivered event must never
  double-assign or double-comment.
- The workflow-admin fallback tier never fires when a schedule cascade (primary/backup/
  escalation) actually resolved someone — it is strictly the last resort, checked whenever
  neither `getActiveScheduleForTeam` nor `resolveOncallCascade` produced an assignee (both
  fail-open exits, not just one).
- `team_id` seeded via `createEntityType` is always `isRequired: false` — never becomes a second
  auto-required field alongside `title` (that would break the "exactly one of user/team" UX this
  spec adds, since a ticket assigned by User would then be missing a "required" team field).
- `team_id`'s value is only ever mutated through the User/Team assign-mode toggle — it is never
  rendered or editable via the generic Other-tab custom-field list on either creation form, so
  there is exactly one code path that can set it, never two that could disagree.
- Every terminal outcome of `resolve_oncall` (assigned via any of the 4 tiers, or fully
  fail-open) posts exactly one system comment — "terminal" includes the fail-open case, not only
  successful assignment.

## §T Tasks

| id  | task                                                                                                                                         | phase | status | depends |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1  | Confirm/choose `team_id` entity-field `fieldType` (entity-ref to `teams.id` vs plain text) — gap                                             | 1     | todo   | —       |
| T2  | Seed `team_id` (optional) in `createEntityType`, alongside existing `title` auto-seed                                                        | 1     | todo   | T1      |
| T3  | One-off backfill: add `team_id` field to existing dev-tenant workflows missing it                                                            | 1     | todo   | T2      |
| T4  | `CreateEntitySchema`: `assignedTo`/`teamId` exactly-one-of refinement, write `teamId` to `fields.team_id`                                    | 1     | todo   | T2      |
| T5  | Extend `CascadeResult`/`OncallTier` union with `"workflow_admin"`                                                                            | 2     | todo   | —       |
| T6  | `resolve-oncall.ts`: workflow-admin fallback lookup + assignment, wired into BOTH fail-open exits (no-schedule-at-all AND cascade-exhausted) | 2     | todo   | T5      |
| T7  | New automation-engine comment-posting helper (workflowEvents + outboxEvents, no apps/api import)                                             | 2     | todo   | —       |
| T8  | Wire T7 into `resolve-oncall.ts`'s success AND both fail-open exit paths, single-comment invariant, exact copy per R5                        | 2     | todo   | T6,T7   |
| T9  | admin-ui: User/Team toggle on `record-create.tsx` Mandate tab; `team_id` excluded from Other-tab custom-field list                           | 3     | todo   | T4      |
| T10 | admin-ui: same toggle + Other-tab exclusion on `instance-create.tsx`                                                                         | 3     | todo   | T4      |
| T11 | Isolation tests: both fail-open exits -> workflow-admin tier, comment content/idempotency for all 4 tiers + fail-open                        | 2     | todo   | T8      |
| T12 | Isolation tests: `CreateEntitySchema` exactly-one-of enforcement (neither/both rejected)                                                     | 1     | todo   | T4      |
| T13 | Isolation/unit test: `team_id` never appears in Other-tab field list on either creation form                                                 | 3     | todo   | T9,T10  |

phase gate: all unit + integration tests pass before advancing to next phase

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |

---

_spec is source of truth — update as decisions are made_
