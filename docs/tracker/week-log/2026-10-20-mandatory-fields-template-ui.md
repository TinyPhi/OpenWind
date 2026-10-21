# 2026-10-20 — Mandatory ticket fields PR 2.4: automation ticket template in the wizard

**Session type:** feature (docs/specs/mandatory-ticket-fields.md R7, T8 UI)
**Branch:** `feat/mandatory-fields-wizard-template` (off `main` after #1032 merged on 2026-10-21)

- **Gap.** The automation wizard only offered notify, set field, transition and webhook: a
  rule that creates a ticket existed only through module seeds or the API.
- **Wizard.** New "Create ticket" (`create_entity`, pick the workflow; its entity type is
  saved) and "Create sub-task" (`create_child`) actions with the template form: title, due in N
  days (3), remark, severity (medium), and assign to the workflow owner (automatic), a person,
  or a team (its on-call person). The rule's name is entered after the actions, so a blank
  title and remark are filled from it on save ("<rule>", "Created by automation: <rule>"); a
  sub-task's blank title is left to the engine ("<rule>: <parent title>"). The actions step
  won't advance without the workflow, a whole-number due (0-3650) and a severity.
- **Editing.** An existing create rule loads its template; config the form doesn't show
  (`fields`, `writeBackField`, `descriptionTemplate`, legacy `assignedTo`) is kept as is.
- **Rules list.** A rule whose create action lacks a template value shows "Needs template"; it
  keeps running on the engine defaults until edited.
- **Tests.** Template rules (problems, completion on save, needs-template), the wizard's
  actions-step gate, and the form (defaults, workflow pick keeping other config, person/team).
