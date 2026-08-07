# Due Date

> Every ticket gets a default `due_date`/`due_at`, independent of workflow state/SLA, with its
> own overdue alerting — separate from SLA breach notifications.

status: implemented
created: 2026-08-06
updated: 2026-08-07

---

## §G Goal

`entity_instances` gains a system-level `due_date` (nullable timestamptz), present on every
ticket regardless of module/admin field config — same tier as `assigned_to`, not an
`entity_fields` row. Ticket-access users/admins can set/edit/clear it any time, independent of
workflow state (unlike SLA, it does not reset on transition). Existing rows get `NULL` and are
backfillable in place. Passing the due date fires a distinct `entity.due_date_overdue`
automation trigger — wired through `automation_rules` for notify actions — fully decoupled from
the SLA outbox/scheduler machinery.

## §C Constraints

| constraint       | value                                                                                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| stack            | Hono API, Drizzle/Postgres, BullMQ, apps/admin-ui                                                                                                                                                                                                                                                |
| auth             | reuse `hasEntityReadAccess`/`entity-access.ts`; write gate mirrors `update.ts`'s existing `isAdminOrAgent`-or-ownership check                                                                                                                                                                    |
| durability       | separate outbox+poller, modeled on `sla-scheduler.ts`/`ticket_alerts`' `alert-scheduler.ts` pattern — do not touch `sla-scheduler.ts`/`sla-breacher.ts`                                                                                                                                          |
| RLS              | no new table for the column itself (it lives on `entity_instances`, existing RLS applies); new outbox rows use existing `outbox_events` RLS                                                                                                                                                      |
| scope (MVP)      | single trigger `entity.due_date_overdue`, fires once when `due_date` passes. No "approaching/reminder" trigger, no recurrence — explicit out-of-scope for this pass                                                                                                                              |
| out of scope     | per-instance reminder offsets, admin_audit_log entries for due_date edits (same rationale as ticket_alerts — not a content mutation worth auditing at this pass), merging with SLA/ticket_alerts code paths                                                                                      |
| migration number | 0052. NOTE (2026-08-06): this branch is 4 commits behind `upstream/main` (TinyPhi/OpenWind), which already added `0051_module_category.sql` — 0052 was chosen deliberately to avoid that collision. Whoever merges this must confirm 0052 is still free once rebased onto current upstream/main. |
| timezone         | browser-local input, stored UTC                                                                                                                                                                                                                                                                  |
| poll interval    | `due-date-scheduler.ts` polls every 10s, matching `sla-scheduler.ts`/`alert-scheduler.ts` cadence                                                                                                                                                                                                |

## §I Interfaces

**Column**: `entity_instances.due_date timestamptz NULL` — migration 0052, no default, no
backfill logic needed (NULL is correct for existing rows).

**Outbox event**: `event_type = 'entity.due_date_scheduled'`, `payload = { instanceId, dueDate }`,
written in the same transaction as any insert/update that sets a non-null `due_date`. Setting
`due_date` to `NULL` or to a new value on an instance with a still-pending scheduled event must
cancel/replace the prior one (mirrors `ticket_alerts` R6 reschedule/cancel semantics) —
implementation: mark prior undelivered `entity.due_date_scheduled` outbox row for this instance
as superseded/delivered before inserting the new one, in the same transaction.

**BullMQ**: new queue `due-date` in `apps/worker/src/queues.ts` (same `defaultJobOptions` as
`slaQueue`/`ticketAlertsQueue`: `attempts:3`, exponential backoff). Job id: `duedate-{outboxEventId}`
(deterministic, dash not colon).

**API** (extend existing routes, no new endpoints):

- `apps/api/src/routes/entities/create.ts:14` — add `dueDate: z.string().datetime().nullable().optional()` beside `assignedTo`.
- `apps/api/src/routes/entities/update.ts:13` — add `dueDate: z.string().datetime().nullable().optional()` beside `assignedTo`; write gate at `:26-42` extended to permit `dueDate` writes under the same `isAdminOrAgent`-or-ticket-access condition (not a stricter one), so a legacy NULL row is fillable by anyone with ticket access, not only its assignee.
- `apps/api/src/routes/entities/bulk-update.ts` — mirror `assignedTo` handling (`:1461-1462`, `:1514-1517` in `engine.ts`) for `dueDate`.

**entity-engine** (`packages/entity-engine/src/engine.ts`): treat `due_date` exactly like
`assignedTo` — a system column set directly in `updates`/`updateValues`, bypassing per-module
`entity_fields`/`validatedFields`:

- create path: `:237` region — add `dueDate: input.dueDate ?? null`.
- update (single) path: `:493-499` region and `:668-676` state-change branch — add `dueDate` alongside `assignedTo`.
- bulk update path: `:1461-1462`, `:1514-1517` — add `dueDate` alongside `assignedTo`.
- read/serialize: `:1116`, `:1221` — add `dueDate: row.dueDate ?? null` as a top-level key alongside `assignedTo`.
- on any of these paths setting a non-null `dueDate` (or changing it from a prior non-null value), write the outbox event described above in the same transaction; on setting it to `null` or on instance archive/delete, supersede any pending `entity.due_date_scheduled` outbox row and remove/no-op the BullMQ job.

**Automation trigger**: add `"entity.due_date_overdue"` to the trigger union in
`packages/automation-engine/src/types.ts` (alongside `"workflow.sla_breached"`, `"field.changed"`).
Fired by the new worker consumer when `due_date` has passed and the instance hasn't been
archived/deleted and `due_date` hasn't changed since the job was scheduled (re-check at fire time
— TOCTOU guard mirroring `sla-breacher.ts:77-113`).

**Worker** (`apps/worker/src`):

- `due-date-scheduler.ts` — polls `outbox_events` for undelivered `entity.due_date_scheduled` rows, enqueues delayed `due-date` queue job at `dueDate`. Mirrors `sla-scheduler.ts` shape; separate file, no shared code with SLA.
- `due-date-worker.ts` — fire-time consumer: re-check instance still exists, not archived, `due_date` still equals the scheduled value; if so, emit `entity.due_date_overdue` outbox event (drives `automation_rules` notify actions same as SLA breach); idempotent (replaying an already-fired job is a no-op).

**Admin-UI**: `apps/admin-ui/src/pages/entity-types/instance-detail.tsx` — add a `due_date`
system-field control alongside the existing `assignedTo` widget (`:95`, `:386,396`), editable by
anyone who can view the ticket, not gated behind admin-only field permissions.

## §R Requirements

R1: Every entity instance has a `due_date` column usable regardless of module/admin field config.
✓ migration 0052 adds nullable `due_date timestamptz` to `entity_instances`; existing rows read back `NULL`
✓ create/update API accepts `dueDate` on any entity type, independent of that type's `entity_fields` config
✓ `dueDate` is never validated against or stored inside per-module `entity_fields`/`fields` jsonb

R2: `due_date` is independent of workflow state — it does not change as a side effect of transitions.
✓ transitioning an instance's `currentState` leaves an existing `due_date` value unchanged
✓ SLA timer scheduling/cancellation (`workflow_states.slaHours`) is unaffected by `due_date` being set, cleared, or edited on the same instance

R3: `due_date` is locked to admin/agent, the record's creator, and workflow admins — the plain
assignee is deliberately excluded, matching the tightened policy also applied to `assignedTo`,
`currentState` (child tickets), and `fields` in the same PATCH gate (2026-08-06 decision — see §V).
✓ the record's creator (or admin/agent, or a workflow admin) can PATCH `dueDate` on a row where it is currently `NULL`
✓ a user who is only the record's assignee (not creator, admin/agent, or workflow admin) gets 404 on the PATCH (matches existing cross-tenant convention — not 403)
✓ clearing `dueDate` (set to `null`) is accepted and supersedes any pending overdue trigger for that instance

R4: Passing the due date fires an overdue automation trigger, decoupled from SLA.
✓ setting a future `due_date` schedules an `entity.due_date_scheduled` outbox row in the same transaction as the write — never one without the other
✓ when `due_date` passes (and the instance is unchanged since scheduling), `entity.due_date_overdue` fires and any `automation_rules` configured on that trigger execute (e.g. notify)
✓ SLA breach processing throughput/latency is unaffected by due-date volume — verified by keeping schedulers/queues in separate files (`due-date-scheduler.ts`/`due-date-worker.ts`, queue `due-date`), no shared code path with `sla-scheduler.ts`/`sla-breacher.ts`

R5: Editing or clearing `due_date` reschedules or cancels the overdue trigger; no stale/duplicate fires.
✓ editing `due_date` to a new future time results in the overdue trigger firing at the NEW time only
✓ clearing `due_date` results in no overdue trigger firing for the cleared value, regardless of how close to the original time the clear happens (short of the fire transaction already having committed)
✓ a job already in-flight at edit/clear time never produces a duplicate or stale-time trigger (job removal + fresh outbox row, or status-guard no-op, mirroring `ticket_alerts` R6)

R6: Instance archive/delete cascades to cancel any pending overdue trigger.
✓ archiving/deleting an instance with a pending `entity.due_date_scheduled` outbox row cancels it and removes the queued job — no overdue trigger fires afterward

## §V Invariants

- (2026-08-06) `apps/api/src/routes/entities/update.ts`'s single PATCH gate governs `assignedTo`,
  `dueDate`, `fields`, and `currentState` (child tickets) uniformly: admin/agent, the record's
  creator, or a workflow admin — the plain assignee is excluded from all four. This was a
  deliberate tightening (previously `isOwner` included the assignee) applied when adding
  `dueDate`, to keep the four fields consistent. Real (non-child-ticket) workflow transitions are
  unaffected — those remain governed by each transition's own `allowedRoles` config
  (`packages/workflow-engine`), which is intentionally per-workflow and untouched by this change.

- `due_date` is a system column on `entity_instances`, never an `entity_fields`/module-seeded field — every entity type gets it for free.
- `due_date` changes never touch `workflow_states.slaHours`/SLA outbox rows, and SLA transitions never touch `due_date`.
- Every non-null `due_date` write has a corresponding `entity.due_date_scheduled` outbox row in the same DB transaction; every supersede/clear marks the prior row non-live in the same transaction (avoids the #126 bug class).
- `due-date-scheduler.ts`/`due-date-worker.ts` remain independent files/queues from `sla-scheduler.ts`/`sla-breacher.ts` and from `alert-scheduler.ts` — never merged into shared code.
- Fire-time trigger emission is idempotent — replaying an already-fired job produces no duplicate `entity.due_date_overdue` event.

**Known v1 limitation (2026-08-07, flagged in review):** `restoreEntity` does not re-arm the
due-date schedule after restoring an archived instance. The `due_date` column value survives
the archive/restore round-trip, but the `entity.due_date_scheduled` outbox row was cancelled at
archive time (per R6) and is not recreated on restore — so a restored ticket with a due date in
the future will not fire an overdue trigger until its `due_date` is next edited (which
re-triggers scheduling). Acceptable for v1; a proper fix would have `restoreEntity` call
`rescheduleDueDate` for any restored instance with a non-null `due_date` in the future.

## §T Tasks

| id  | task                                                                                                            | phase | status | depends |
| --- | --------------------------------------------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1  | Migration 0052: add `due_date timestamptz NULL` to `entity_instances`, GRANT if needed, analytics annotation    | 1     | done   | —       |
| T2  | Drizzle schema: add `dueDate` column to `entityInstances` (packages/db/src/schema/entity-engine.ts)             | 1     | done   | T1      |
| T3  | entity-engine: create/update/bulk-update paths set `dueDate` as system column (engine.ts, see §I)               | 1     | done   | T2      |
| T4  | entity-engine: outbox write/supersede for `entity.due_date_scheduled` on set/clear/change (same txn as T3)      | 1     | done   | T3      |
| T5  | entity-engine: read/serialize `dueDate` at top level (engine.ts :1116, :1221)                                   | 1     | done   | T2      |
| T6  | API: extend create/update/bulk-update Zod schemas + write-gate for `dueDate`                                    | 2     | done   | T3      |
| T7  | Automation-engine: add `entity.due_date_overdue` trigger type (types.ts)                                        | 2     | done   | —       |
| T8  | Worker: new `due-date` BullMQ queue (queues.ts)                                                                 | 2     | done   | —       |
| T9  | Worker: `due-date-scheduler.ts` — poller for `entity.due_date_scheduled`, mirrors sla-scheduler.ts shape        | 2     | done   | T4, T8  |
| T10 | Worker: `due-date-worker.ts` — fire-time consumer, TOCTOU re-check, emits `entity.due_date_overdue`, idempotent | 2     | done   | T7, T8  |
| T11 | Cascade-cancel: instance archive/delete cancels pending `entity.due_date_scheduled` row + job                   | 2     | done   | T4, T9  |
| T12 | Admin-UI: due_date field control on instance-detail.tsx alongside assignedTo                                    | 3     | done   | T6      |
| T13 | Isolation/unit tests: R1–R6 acceptance criteria                                                                 | 1-3   | done   | T1-T12  |

phase gate: all unit + integration tests pass before advancing to next phase

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |

---

_spec is source of truth — update as decisions are made_
