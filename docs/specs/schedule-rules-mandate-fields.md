# Schedule Rules — Mandate Fields (assign mode, due date, remark)

> Bring schedule_rules' auto-created tickets in line with manual ticket creation's
> mandatory fields: user/team assign mode (team goes through the on-call cascade),
> a relative due date, and a remark posted as the first comment. Drop the old
> "assign to rule creator" implicit behavior entirely.

status: approved
created: 2026-09-22
updated: 2026-09-22

---

## §G Goal

A schedule rule's ticket template requires exactly the same 4 mandate fields a manually
created ticket requires (assignedTo XOR teamId, dueDate, remark), rendered at each fire.
`assignee_id`-as-"creator fallback" is gone; `team_id` mode resolves via the existing
`entity.created` → `resolve_oncall` cascade, identically to `apps/api/src/routes/entities/
create.ts`'s teamId path — no separate resolution logic for scheduled tickets.

## §C Constraints

| constraint   | value                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| stack        | `packages/scheduler` (TemplateSchema), `apps/worker/src/schedule-tick-worker.ts`, `apps/admin-ui` schedule-rules UI, `apps/api/src/routes/admin/schedule-rules.ts` |
| auth         | unchanged — admin-only CRUD on schedule rules (existing `requireRole("admin")`)                                                                                    |
| out of scope | on-call schedule modal (separate feature, already shipped); cron UI (already simplified — presets exist); recurring due-date presets beyond a plain day count      |
| migration    | template is JSONB, no DB schema migration needed — TemplateSchema (Zod) shape change only                                                                          |

## §I Interfaces

`Template` (packages/scheduler/src/template.ts), replacing today's shape:

```ts
{
  title: string;              // unchanged, {{token}} substitution
  description?: string;       // unchanged
  severity?: "critical" | "high" | "medium" | "low"; // unchanged
  service_id?: string;        // unchanged, still independent of assign mode
  remark: string;             // NEW — required, becomes first comment (postRemarkComment)
  due_days: number;           // NEW — required, int >= 0; due date = scheduledAt + N days
  assignedTo?: string;        // renamed from assignee_id, exactly one of these two
  teamId?: string;            // renamed from team_id (wire/template key only —
                               // still written into fields.team_id at fire time,
                               // matching create.ts's own field name)
}
```

Exactly one of `assignedTo`/`teamId` required (superRefine, mirrors `CreateEntitySchema`
in `apps/api/src/routes/entities/create.ts`).

Worker (`fireRule` in schedule-tick-worker.ts) createEntity call, mirroring create.ts:

- `assignedTo` mode → `createEntity(..., assignedTo: rendered.assignedTo, dueDate, ...)`,
  fields unchanged (no `team_id` key written).
- `teamId` mode → `createEntity(..., fields: { ...fields, team_id: rendered.teamId }, dueDate, ...)`,
  no `assignedTo` passed — same as create.ts leaving assignment to the async
  `entity.created` → `resolve_oncall` pipeline.
- `dueDate` = `scheduledAt` (the fire's own scheduled instant, not `tickTime`) +
  `rendered.due_days` days, ISO string.
- After the transaction commits (same best-effort, outside-transaction, catch-and-log
  pattern as create.ts), call `postRemarkComment` with `actorId: rule.createdBy` (the
  rule's own creator — there is no live human actor for a scheduled fire) and
  `text: rendered.remark`.

## §R Requirements

R1: Schedule rule template requires exactly one of `assignedTo`/`teamId`, same as manual
ticket creation.
✓ Zod schema rejects a template with both set (422 on create/update route)
✓ Zod schema rejects a template with neither set
✓ Existing rules with the old `assignee_id`/`team_id` shape fail validation on next
PATCH (no live migration of existing rows — acceptable since 3F has no production
tenants yet; documented in §V)

R2: `teamId` mode resolves via the existing on-call cascade, not a separate code path.
✓ `fireRule` writes `fields.team_id` and does not pass `assignedTo` to `createEntity`
✓ The already-existing `entity.created` automation rule (fields.team_id present) fires
`resolve_oncall` for a rule-created ticket exactly as it does for a manually created one
✓ Isolation/integration test: firing a team-mode rule results in the same system comment
format as a manually created team-assigned ticket (reuses existing resolve-oncall tests'
assertions, applied to a rule-created instance)

R3: `assignedTo` mode still supported (single explicit user), unchanged behavior from
today's `assignee_id`.
✓ `fireRule` passes `assignedTo: rendered.assignedTo` directly to `createEntity`, no cascade

R4: Every fired ticket has a due date = fire's scheduled instant + `due_days` days.
✓ `due_days: 0` → due date equals the scheduled fire instant
✓ `due_days: 3` → due date is exactly 3×86400000 ms after the scheduled fire instant

R5: Every fired ticket gets its `remark` posted as its first comment, attributed to the
rule's creator.
✓ After a successful fire, `GET` the created ticket's comments → exactly one comment,
`text === rendered.remark`, actor is `rule.createdBy`
✓ A remark-post failure is caught and logged, never fails the fire itself (ticket +
schedule_executions row still get created) — same contract as create.ts's own
best-effort remark posting

R6: UI (schedule-rules create/edit modal) mirrors record-create.tsx's Mandate tab: a
User/Team toggle (radio-style buttons, same visual pattern), a due-date-in-days numeric
input, and a remark textarea — replacing today's bare `assignee_id`/`team_id` inputs
(today's UI has no input for these at all — they're template-only, never exposed).
✓ Selecting "Team" shows a team picker and hides the user picker, and vice versa
✓ Submitting without a remark or due_days is blocked client-side (mirrors record-create's
own required-field guard) — server-side Zod is still the enforced boundary

R7 (2026-09-22 amendment, supersedes this spec's original "ticket-only" framing): a
schedule rule's entity type is derived from its selected workflow, not hardcoded to
"ticket" — matching manual creation (record-create.tsx), which is not restricted to any
one entity type either. `entityTypeId` is never sent by the client; the server resolves it
from `workflowId` (falling back to the tenant's "ticket" entity type only when no workflow
is selected). `validateScheduleRuleRefs`'s earlier `entityType.name !== "ticket"` rejection
is removed.
✓ Creating a rule with a workflow on a non-ticket entity type succeeds, and the created
instance's `entity_type_id` matches that workflow's own `entity_type_id`
✓ Changing a rule's `workflowId` via PATCH re-resolves and persists the new matching
`entityTypeId` — a rule's stored entity type never drifts out of sync with its current
workflow
✓ Team-assignment mode still only resolves an assignee for the "ticket" entity type
specifically — that is `resolve_oncall`'s own automation-rule trigger scoping
(`modules/helpdesk/seed/003_automation_rules.sql`, `trigger_config: {"entityType":
  "ticket"}`), a pre-existing platform-wide constraint this change does not touch or
expand. A rule on a non-ticket workflow with `teamId` set creates the entity
successfully but its `team_id` is never resolved to an assignee — documented behavior,
not a bug, identical to what manual team-assign creation already does today for any
non-ticket entity type.

## §V Invariants

- Exactly one of `assignedTo`/`teamId` on a schedule rule template, enforced by Zod
  `superRefine`, mirroring `CreateEntitySchema` — never let both or neither reach the
  worker.
- A rule-created ticket's on-call resolution path is byte-for-byte the same automation
  rule/action as a manually created one (`resolve_oncall`) — no schedule-rule-specific
  fork of that cascade is ever introduced.
- `postRemarkComment` failures never fail a schedule fire (`scheduleExecutions.status`
  stays `"success"` even if the remark post throws) — matches create.ts's own contract.
- No live-data migration for existing schedule_rules rows carrying the old
  `assignee_id`/`team_id` template shape (2026-09-22 decision — 3F has shipped no
  production tenants yet, per roadmap-tracker; if that changes before this ships, a
  migration writing the renamed keys becomes required before merge).

## §T Tasks

See `docs/specs/schedule-rules-mandate-fields-tasks.md` (generated by `/spec-tasks`).

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |
| —   | —           | —          | —               |

---

_spec is source of truth — update as decisions are made_
