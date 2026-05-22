# Prompt: Seed a new business module

Modules are **pure configuration** — seed SQL rows only, zero new TypeScript.
The entity, workflow, and automation engines interpret the config at runtime.

The test: if you are writing TypeScript inside `modules/`, something is wrong.

## Files to create

```
modules/<name>/
  001_entity_types.sql      # entity_types + entity_fields rows
  002_workflow.sql           # workflows + workflow_states + workflow_transitions rows
  003_automation_rules.sql   # automation_rules rows
  README.md                  # entity types, workflow, trigger/action summary
```

All SQL files use `{TENANT_ID}` as a placeholder — the seed runner substitutes it at install time.

## Template prompt

"Seed the [MODULE_NAME] module. It has these entity types: [ENTITIES WITH FIELD NAMES AND TYPES].

The primary workflow is: states [STATES], transitions [TRANSITIONS], SLA on [WHICH STATES].

Automation rules needed: [TRIGGER → ACTION PAIRS].

Create:

- `modules/[name]/001_entity_types.sql` — entity_types and entity_fields INSERT rows
- `modules/[name]/002_workflow.sql` — workflows, workflow_states, workflow_transitions INSERT rows
- `modules/[name]/003_automation_rules.sql` — automation_rules INSERT rows
- `modules/[name]/README.md` — summary table of entity types, fields, workflow, automations

Use `{TENANT_ID}` as the placeholder throughout. Reference the existing helpdesk seed as a pattern once it exists."

## Checklist before merging a new module seed

- [ ] Module row inserted into `modules` registry table (`name`, `slug`, `description`, `version`)
- [ ] All entity_type rows have `tenant_id = '{TENANT_ID}'`
- [ ] All field types are valid values from `entity_fields.field_type` enum
- [ ] `entity_fields` rows include `label` (NOT NULL) and use `is_required` (not `required`)
- [ ] `entity_types` rows include `plural` (NOT NULL); no `slug` column
- [ ] Workflow terminal states have no outgoing transitions
- [ ] SLA states have a `sla_hours` value set
- [ ] Automation rule conditions are valid JSON rule trees (see ADR-002 grammar)
- [ ] README summarises the module for human readers
- [ ] No TypeScript files introduced anywhere in `modules/`
