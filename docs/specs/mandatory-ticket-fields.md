# Mandatory Ticket Fields — the five, on every ticket

> Every record on every workflow (sub-tasks included) always carries title, due date, remark,
> assignee (user or team) and severity — on create, after every edit, whatever created it.
> Owner rule (2026-10-15): other features (title search, due-date evaluation and filters,
> assignee filters) assume them; a ticket without them gets lost.

status: in-progress
created: 2026-10-15
updated: 2026-10-15

---

## §G Goal

The five mandatory fields are present and valid on 100% of `entity_instances` that belong to a
workflow, and no API, worker, automation, UI or admin action can create a record without
them, clear them, or make them optional. Workflows differ only in states/transitions and in
their own extra fields (create page "Others" tab), which admins may make required.

## §C Constraints

| constraint   | value                                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the five     | `fields.title` (entity field) · `due_date` · `remark` · `assigned_to` or `fields.team_id` (exactly one on create input; resolve_oncall may later set both) · `severity` (columns)                |
| system field | `is_system=true` = protected (no rename/delete/optional — ADR-004 CF-01, ADR-016 D3). NOT "hidden"                                                                                               |
| hidden/RO    | engine-written fields use field `config.readOnly: true` — shown as text, never an input (tender `submitted_at`/`submitted_by`)                                                                   |
| ADRs         | ADR-003 (validation), ADR-004 CF-01, ADR-016 D3 — consistent. **ADR-012 needs a human amendment** (R6). ADRs are human-authored                                                                  |
| out of scope | label/config changes on the title field (system = fully immutable, accepted); DB-level CHECK constraints (app-layer first; revisit after R9 backfill); child-ticket 3-state machine itself       |
| scope        | a workflow record: `workflowId` set, its entity type has a workflow, or a sub-task. Comments are workflow_events rows; helpdesk articles have no workflow                                        |
| rollout      | engine check `MANDATORY_FIELDS_MODE=log` (default) logs, `enforce` rejects (422); set by api/worker at startup. Sub-task create enforces at the route at once                                    |
| split        | PR 1 = R1–R3 + R10 + §B fixes (#965); PR 2.1 engine check + create paths; 2.2 automation/scheduler/seeder/install owner; 2.3 edits + erasure; 2.4 template UI; 2.5 fixtures + enforce + backfill |

## §I Interfaces

- `entity_fields` row `title`: `is_system=true, is_required=true`, on every tenant entity type
  that backs a workflow (module seeds, UI-created types, existing rows via migration).
- Field config key `readOnly?: boolean` (admin-ui `FieldInputField.config`; seed-set only).
- Schedule + automation "create ticket" template: `{ title, dueDays, remark, severity,
assignedTo | teamId, fields? }`, pre-filled from the selected workflow.
- `PATCH /entities/:id`: `dueDate` non-null; `assignedTo` non-null unless switching to
  `teamId`; `severity` accepted (non-null); `remark` not accepted (fixed after create).
- Fallback owner = the workflow owner (`workflows.created_by`), used by R6/R7/R8.

## §R Requirements

R1: Title is a protected, required field on every workflow.
✓ Every module seed's workflow entity type defines `title` with is_required + is_system true (guard test parses all seeds; vendor gets a title)
✓ A UI-created entity type auto-seeds `title` as is_system + is_required
✓ Existing tenants: migration sets title is_system/is_required true on every tenant entity type that has one
✓ Admin can't delete `title`, make it optional, or edit it (API `SYSTEM_FIELD_IMMUTABLE`; UI hides delete/edit)
✓ A blank or whitespace-only title is rejected on create and on edit

R2: Protected fields are visible and editable wherever record fields are.
✓ Record detail: read view, Edit form and heading show system fields (helpdesk title, description, priority…)
✓ Records list title search and admin record-create include system fields
✓ A field with `config.readOnly` shows as text in view and edit, never an input; tender `submitted_at`/`submitted_by` seeded + migrated to readOnly

R3: Ticket page Edit can't remove a mandatory value.
✓ No "Unassigned" option in Edit or quick-assign; due date can't be cleared
✓ Severity editable in Edit (and quick dropdown), never clearable
✓ Remark not editable after create (it is the first comment)
✓ Due date: a changed value must be in the future; an untouched past value saves (overdue ticket, title-only edit)
✓ Saving an edit does not shift the due date by the browser's timezone offset

R4: The server enforces the five on every create path.
✓ `createEntity` (engine) rejects a workflow record missing any of the five — covers POST /entities, bulk create, internal + third-party sub-tasks, automation create_entity/create_child, scheduler, sandbox seeder, demo script
✓ Sub-tasks require all five (same as a full ticket)
✓ Team assignment survives on every type (no silent strip of `team_id` when the type lacks the field)
✓ Scheduler writes severity + remark to their columns (not `fields.severity` / comment-only)

R5: The server rejects edits that would remove a mandatory value.
✓ PATCH /entities/:id and bulk PATCH reject null/blank due date, assignee (unless team set), title; reject a past due date when changed
✓ Severity editable via PATCH; never null

R6: Partner API never creates an unassigned ticket.
✓ Unresolvable assignee → assigned to the workflow owner + system comment (ticket + sub-ticket)
✓ BLOCKED on a human ADR-012 amendment before ship

R7: Automation and schedule rules use a full template.
✓ Picking a workflow pre-fills a template: title, due (in N days), assignee/team, remark, severity (default medium); rule can't be saved without them
✓ Existing automation rules missing template values keep running on defaults (due +3 days, medium, remark "Created by automation: <rule>", workflow owner) and are flagged "needs template" in the rule list

R8: Removing a user never leaves tickets unassigned.
✓ User erasure / org removal reassigns their tickets to the workflow owner, with a system comment that does not name the removed user

R9: Existing records are backfilled once.
✓ Missing title → "Untitled ticket #<short id>"; due date → created_at + 7 days; remark → "Backfilled: no remark was recorded when this ticket was created."; severity → medium; assignee → creator, else workflow owner
✓ After the backfill, a check query finds zero workflow records missing any of the five

R10: Schedule rule assigned to a user saves.
✓ Template `assignedTo` accepts a Zitadel user id (18-digit numeric), not only a UUID; tests use real-shaped ids

## §V Invariants

- `is_system` means protected, never hidden. Hiding/read-only is `config.readOnly`.
- Every workflow record has all five, always. No code path may write NULL/blank to any of them.
- User-id fields are Zitadel ids (numeric strings) — never validate them as UUIDs; test fixtures use real-shaped ids.
- An assignment fallback is the workflow owner, never "nobody".

## §T Tasks

| id  | task                                                                                        | phase | status                           | depends                   |
| --- | ------------------------------------------------------------------------------------------- | ----- | -------------------------------- | ------------------------- |
| T1  | R10 scheduler assignedTo accepts Zitadel ids + tests                                        | 1     | done #965                        | —                         |
| T2  | R1 title protected+required: auto-seed, module seeds (+vendor title), migration, guard test | 1     | done #965                        | —                         |
| T3  | R1 blank title rejected (engine text validation for `title`)                                | 1     | done #965                        | —                         |
| T4  | R2 UI shows system fields; `config.readOnly` rendering; tender seed + migration             | 1     | done #965                        | —                         |
| T5  | R3 ticket Edit: no unassign, no clear due date, future-only when changed, severity, TZ fix  | 1     | done #965                        | —                         |
| T6  | R4 engine create-time enforcement + all create paths supply the five; team_id strip fix     | 2     | 2.1 engine + API paths; 2.2 rest | PR 1                      |
| T7  | R5 PATCH/bulk PATCH enforcement                                                             | 2     | todo                             | T6                        |
| T8  | R7 automation template (UI + config schema) + "needs template" flag + defaults              | 2     | todo                             | T6                        |
| T9  | R8 erasure/removal reassign to workflow owner                                               | 2     | todo                             | T6                        |
| T10 | R9 backfill migration + zero-missing check                                                  | 2     | todo                             | T6–T9                     |
| T11 | R6 partner API fallback owner                                                               | 2     | blocked                          | ADR-012 amendment (human) |

phase gate: PR 1 merged and on the server before PR 2 starts. Owner overrode this on 2026-10-16: PR 2 stacks on #965.

## §B Bugs / Backprop Log

| id  | what failed                                                                                                                         | root cause                                                                                          | promoted to §V? |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------- |
| B1  | Helpdesk ticket detail: no title in view/Edit/heading, "No custom fields defined."                                                  | UI treats `is_system` as hidden; helpdesk seed marks every ticket field system                      | yes (1st)       |
| B2  | First fix (drop UI filter) would expose tender's engine fields as inputs; second (seed non-system) broke ADR-016 D3 / ADR-004 CF-01 | two meanings of `is_system`; resolved by `config.readOnly` for hiding                               | yes (1st)       |
| B3  | Schedule rule assigned to a user → 400 "assignedTo invalid" (server + local)                                                        | template validated `assignedTo` as UUID; Zitadel ids are numeric; fixtures used fake UUIDs          | yes (3rd)       |
| B4  | Helpdesk ticket created with teamId ends with no assignee and no team                                                               | `team_id` written into `fields`, stripped by the type's schema when the type has no `team_id` field | yes (2nd)       |
| B5  | Sandbox, automation, scheduler and bulk tickets lacked due date/remark/assignee/severity although the create page required them     | the rule lived only in POST /entities and the create page; the engine enforced none of it           | yes (2nd)       |
| B6  | A record could name another tenant's team, or a workflow of a different entity type                                                 | no tenant check on `team_id`; createEntity never checked the workflow against the type              | no (fixed 2.1)  |

---

_spec is source of truth — update as decisions are made_
