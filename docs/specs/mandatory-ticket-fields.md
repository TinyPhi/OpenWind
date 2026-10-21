# Mandatory Ticket Fields — the four, on every ticket

> Every record on every workflow (sub-tasks included) always carries title, due date, remark
> and severity — on create, after every edit, whatever created it. Owner rule (2026-10-15):
> other features (title search, due-date evaluation and filters) assume them; a ticket without
> them gets lost. The assignee is optional (owner decision 2026-10-19): an unassigned ticket
> stays on its workflow's records list, under the assignee filter's "Unassigned" entry.

status: in-progress
created: 2026-10-15
updated: 2026-10-21

---

## §G Goal

The four mandatory fields are present and valid on 100% of `entity_instances` that belong to a
workflow, and no API, worker, automation, UI or admin action can create a record without
them, clear them, or make them optional. Workflows differ only in states/transitions and in
their own extra fields (create page "Others" tab), which admins may make required.

## §C Constraints

| constraint   | value                                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the four     | `fields.title` (entity field) · `due_date` · `remark` · `severity` (columns). Assignee optional: at most one of `assigned_to`/`fields.team_id` on create input (a team resolves to its on-call person) |
| system field | `is_system=true` = protected (no rename/delete/optional — ADR-004 CF-01, ADR-016 D3). NOT "hidden"                                                                                                     |
| hidden/RO    | engine-written fields use field `config.readOnly: true` — shown as text, never an input (tender `submitted_at`/`submitted_by`)                                                                         |
| ADRs         | ADR-003 (validation), ADR-004 CF-01, ADR-016 D3 — consistent. ADR-012 needs no amendment now that unassigned is allowed (R6). ADRs are human-authored                                                  |
| out of scope | label/config changes on the title field (system = fully immutable, accepted); DB-level CHECK constraints (app-layer first; revisit after R9 backfill); child-ticket 3-state machine itself             |
| scope        | a workflow record: `workflowId` set, its entity type has a workflow, or a sub-task. Comments are workflow_events rows; helpdesk articles have no workflow                                              |
| rollout      | engine check `MANDATORY_FIELDS_MODE=log` (default) logs, `enforce` rejects (422); set by api/worker at startup. Sub-task create enforces at the route at once                                          |
| split        | PR 1 = R1–R3 + R10 + §B fixes (#965); PR 2.1 engine check + create paths; 2.2 automation/scheduler/seeder/install owner; 2.3 edits + erasure; 2.4 template UI; 2.5 fixtures + enforce + backfill       |

## §I Interfaces

- `entity_fields` row `title`: `is_system=true, is_required=true`, on every tenant entity type
  that backs a workflow (module seeds, UI-created types, existing rows via migration).
- Field config key `readOnly?: boolean` (admin-ui `FieldInputField.config`; seed-set only).
- Schedule + automation "create ticket" template: `{ title, dueDays, remark, severity,
assignedTo | teamId, fields? }`, pre-filled from the selected workflow.
- `PATCH /entities/:id` and bulk PATCH: `dueDate` can change, never be null; `assignedTo` may
  be null (unassign); severity via `PATCH /entities/:id/severity` (non-null); `remark` not
  accepted (fixed after create).
- `GET /entities?unassigned=true`: only records with nobody assigned (the records list's
  "Unassigned" filter, applied server-side so it isn't limited to the first page).
- Fallback assignee (owner decision 2026-10-16), used by R7 and the seeder when a rule names
  nobody: the workflow's creator, then its workflow admins (current tenant members, not erased),
  then the tenant's longest-standing admin (Zitadel admin role, earliest `tenant_users` join).
  Decided at run time; no migration. With nobody found the ticket is created unassigned
  (2026-10-19). Installing a module records the installer as owner of its ownerless workflows.
- Team assignment (owner decision 2026-10-19): a team is a way to reach whoever is on call. The
  two seeded `resolve_oncall` rules are unscoped, so a team-assigned record on any workflow gets
  the team's on-call person; a scheduler rule names a person (assigned directly) or a team.
- Automation default title (owner decision 2026-10-16): the rule's name; a sub-task gets
  `<rule name>: <parent title>`.
- Scheduler due date (owner decision 2026-10-16): the ticket's creation time + `due_days`, not
  the scheduled fire time, so a late catch-up run still gets its full N days.

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
✓ Due date can't be cleared; "Unassigned" is offered in Edit, quick-assign, the create form (its default) and the sub-task form (2026-10-19)
✓ Severity editable in Edit (and quick dropdown), never clearable
✓ Remark not editable after create (it is the first comment)
✓ Due date: a changed value must be in the future; an untouched past value saves (overdue ticket, title-only edit)
✓ Saving an edit does not shift the due date by the browser's timezone offset

R4: The server enforces the four on every create path.
✓ `createEntity` (engine) rejects a workflow record missing any of the four — covers POST /entities, bulk create, internal + third-party sub-tasks, automation create_entity/create_child, scheduler, sandbox seeder, demo script
✓ Sub-tasks require the same four (same as a full ticket); the assignee is optional
✓ Team assignment survives on every type (no silent strip of `team_id` when the type lacks the field)
✓ Scheduler writes severity + remark to their columns (not `fields.severity` / comment-only)

R5: The server rejects edits that would remove a mandatory value.
✓ PATCH /entities/:id and bulk PATCH reject a null due date and a blank title; a changed due date must not be in the past, an untouched overdue one saves
✓ The engine checks every update (any caller, automations included) and flags only a value the record had (log, or reject under enforce); an older record missing a value can still be edited
✓ Severity editable via PATCH; never null
✓ A fields edit keeps the keys the type doesn't define (`__accessUsers`, a `team_id` on a type without that field)

R6: Partner API: an unresolvable assignee leaves the ticket unassigned, with a system comment.
✓ Already ADR-012's behaviour; no amendment needed since unassigned is allowed (2026-10-19)

R7: Automation and schedule rules use a full template.
✓ Picking a workflow pre-fills a template: title, due (in N days), assignee/team, remark, severity (default medium); rule can't be saved without them
✓ Existing automation rules missing template values keep running on defaults (due +3 days, medium, remark "Created by automation: <rule>", workflow owner) and are flagged "needs template" in the rule list
✓ The automation wizard has "Create ticket" (pick a workflow) and "Create sub-task" actions with the template form; a blank title/remark is filled from the rule's name on save (a sub-task's blank title stays "<rule>: <parent title>"); assignee: workflow owner (automatic), a person, or a team

R8: Removing a user leaves their tickets unassigned (2026-10-19), visible under the "Unassigned" filter.
✓ Erasure's existing unassign is kept; no reassignment

R9: Existing records are backfilled once.
✓ Missing title → "Untitled ticket #<short id>"; due date → created_at + 7 days; remark → "Backfilled: no remark was recorded when this ticket was created."; severity → medium
✓ After the backfill, a check query finds zero workflow records missing any of the four

R10: Schedule rule assigned to a user saves.
✓ Template `assignedTo` accepts a Zitadel user id (18-digit numeric), not only a UUID; tests use real-shaped ids

R11: Unassigned tickets are findable.
✓ The workflow records list's assignee filter has "Unassigned", applied server-side (`unassigned=true`)

R12: A team assignment reaches a person on every workflow.
✓ The seeded on-call rules carry no entity-type scope; a migration widens existing tenants' rules
✓ Scheduler rules keep exactly one of a person or a team

## §V Invariants

- `is_system` means protected, never hidden. Hiding/read-only is `config.readOnly`.
- Every workflow record has all four, always. No code path may write NULL/blank to any of them.
- User-id fields are Zitadel ids (numeric strings) — never validate them as UUIDs; test fixtures use real-shaped ids.
- An unassigned ticket is a valid state, never a hidden one: it shows on its records list and under the "Unassigned" filter.

## §T Tasks

| id  | task                                                                                        | phase | status                               | depends |
| --- | ------------------------------------------------------------------------------------------- | ----- | ------------------------------------ | ------- |
| T1  | R10 scheduler assignedTo accepts Zitadel ids + tests                                        | 1     | done #965                            | —       |
| T2  | R1 title protected+required: auto-seed, module seeds (+vendor title), migration, guard test | 1     | done #965                            | —       |
| T3  | R1 blank title rejected (engine text validation for `title`)                                | 1     | done #965                            | —       |
| T4  | R2 UI shows system fields; `config.readOnly` rendering; tender seed + migration             | 1     | done #965                            | —       |
| T5  | R3 ticket Edit: no unassign, no clear due date, future-only when changed, severity, TZ fix  | 1     | done #965                            | —       |
| T6  | R4 engine create-time enforcement + all create paths supply the five; team_id strip fix     | 2     | done 2.1 #973 + 2.2                  | PR 1    |
| T7  | R5 PATCH/bulk PATCH enforcement + engine update check + fields-edit key fix                 | 2     | done #1032                           | T6      |
| T8  | R7 automation template (UI + config schema) + "needs template" flag + defaults              | 2     | defaults + config 2.2; UI 2.4 (done) | T6      |
| T9  | R8 erasure/removal reassign — dropped 2026-10-19 (unassigned allowed)                       | 2     | dropped                              | —       |
| T10 | R9 backfill migration + zero-missing check                                                  | 2     | todo                                 | T6–T9   |
| T11 | R6 partner API fallback owner — dropped 2026-10-19 (unassigned allowed)                     | 2     | dropped                              | —       |
| T12 | R3/R11 "Unassigned" in create/edit/sub-task forms + records-list filter (server-side)       | 2     | done #1032                           | T6      |
| T13 | R12 on-call rules unscoped (seed + migration)                                               | 2     | done #1032                           | —       |

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
| B7  | Editing a ticket's fields dropped its access grants (`__accessUsers`) and a `team_id` the type doesn't define                       | the create schema strips unknown keys and the update wrote the stripped object over `fields`        | yes (R5)        |
| B8  | A team-assigned ticket on any workflow but helpdesk never got a person                                                              | the seeded `resolve_oncall` rules were scoped to the entity type named `ticket`                     | no (fixed 2.3)  |

---

_spec is source of truth — update as decisions are made_
