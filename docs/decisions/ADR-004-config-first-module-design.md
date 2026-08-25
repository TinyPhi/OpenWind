# ADR-004: Config-First Module Design

**Status:** Accepted  
**Date:** 2026-05  
**Deciders:** Engineering lead, Platform architect  
**Supersedes:** —  
**Superseded by:** —

---

## Context

The platform's three engines (Entity, Workflow, Automation) are generic interpreters. They execute against configuration stored in the database — entity type definitions, field definitions, workflow states, transitions, and automation rules. This raises a foundational question that must be answered explicitly before any module is built:

> **When a new business module is needed (helpdesk, reimbursements, HRMS), where does its business logic live — in TypeScript code or in database configuration?**

Getting this wrong in week 9 (when the first module is built) produces a codebase where:

- Every module has its own routes, its own validators, its own business logic
- Adding a custom field requires a code change and deployment
- Workflow changes require engineering effort
- The engine layer becomes irrelevant as modules bypass it with direct queries

Getting it right means:

- A new module is a seed SQL file — entity types, fields, workflows, automation rules as INSERT statements
- Custom fields are rows a tenant can add without a deployment
- Workflow redesigns happen in a UI without touching code
- The engine layer is the only backend code ever written; modules are configuration of it

This ADR decides the rule and its consequences.

---

## Decision

**Modules are configuration, not code. The engine layer is written once. Business logic lives in the database, not in TypeScript.**

Specifically:

1. **A standard module ships as a seed SQL file** containing INSERT statements for `entity_types`, `entity_fields`, `workflows`, `workflow_states`, `workflow_transitions`, and `automation_rules`. It contains no backend TypeScript.

2. **The engine API is the module API.** There are no module-specific routes. A helpdesk ticket is created via `POST /entities` with `entity_type = ticket`. A workflow transition is executed via `POST /entities/:id/transitions`. These endpoints serve every module.

3. **Business rules are automation rules.** "Notify the assignee when a ticket is escalated" is not code in `modules/helpdesk/` — it is an `automation_rules` row with `trigger = workflow.entered_state`, `conditions = [{state: "escalated"}]`, `actions = [{type: "notify", ...}]`.

4. **Workflow definitions are database rows.** The states, transitions, role guards, SLA hours, and condition expressions for every workflow live in `workflow_states` and `workflow_transitions`. They are edited through the workflow builder UI, not via code changes.

5. **Custom fields are rows.** A tenant adding a `department_code` field to their expense claims writes a row to `entity_fields`. The entity engine includes it in validation automatically. No migration, no deployment.

6. **If you cannot express it as config, the engine needs a new primitive.** The correct response to "I need to write module code for this" is to decide: does the engine need a new trigger type, a new action type, a new field type, or a new condition operator? If yes, write an engine PR (with tests, ADR entry, and PR review). Never write around the engine.

---

## What "module" means under this model

A module is a named bundle of:

| Component                                    | Storage                                                       | Edited by                          |
| -------------------------------------------- | ------------------------------------------------------------- | ---------------------------------- |
| Entity type definitions                      | `entity_types` rows                                           | Seed SQL + admin UI                |
| Field definitions                            | `entity_fields` rows                                          | Seed SQL + field builder UI        |
| Workflow definitions                         | `workflows` + `workflow_states` + `workflow_transitions` rows | Seed SQL + workflow builder UI     |
| Default automation rules                     | `automation_rules` rows                                       | Seed SQL + automation builder UI   |
| Notification template references             | Novu template IDs in automation rule config                   | Novu UI                            |
| UI view config (list columns, detail layout) | `view_configs` rows (JSONB)                                   | Seed SQL + UI                      |
| Frontend components (list, detail, forms)    | Generic engine-driven components                              | None required for standard modules |

A module has no:

- Dedicated API routes
- Custom Zod validation schemas (field validation is generated at runtime from `entity_fields`)
- TypeScript business logic
- Custom database tables (beyond what the engine provides)
- Custom middleware

---

## The config-first checklist

Every PR that touches a module must pass this checklist before review:

- [ ] Is any business logic written in TypeScript that could instead be an automation rule row?
- [ ] Is any workflow state or transition hardcoded in TypeScript rather than in `workflow_states`/`workflow_transitions`?
- [ ] Is any validation rule hardcoded in a Zod schema rather than in an `entity_fields.config` row?
- [ ] Is any notification template hardcoded in TypeScript rather than referenced by ID from Novu?
- [ ] Does this require a new API route? If so, is it actually a new engine primitive rather than a module concern?
- [ ] Does this UI need a new page? If so, can the generic entity list/detail/form handle it with different field configuration?

If any answer is "yes," stop and resolve it before proceeding. Either move it to config, or write an engine PR.

---

## The escape hatches (and when to use them)

This model has two intentional escape hatches. They are not loopholes — they are where the config model hits its ceiling.

### 1. Script action (`isolated-vm` sandbox)

When automation logic cannot be expressed by the declarative rule grammar, the `script` action type runs tenant-authored JavaScript in a V8 isolate. This handles the 5% of rules that need conditional branching, external lookups, or transformations the action types do not support.

**When to use:** Logic that is genuinely tenant-specific, one-off, and not reusable across modules. If you find yourself writing the same script for three different tenants, the pattern belongs in a new action type (engine PR).

### 2. Plugin system

When a business requirement needs persistent new data models, custom API routes, custom job types, or complex frontend that cannot be expressed through entity/workflow/automation configuration alone — and when that requirement is reusable across multiple tenants — it ships as a plugin.

A plugin has its own Postgres schema namespace, its own Hono sub-router, and its own migrations. It is not a shortcut to avoid the config-first rule — it is a higher-order extension mechanism for capabilities the three engines genuinely cannot express.

**When NOT to use:** A plugin is not a way to write module code that bypasses the engine. If the requirement can be served by a combination of entity types + workflow config + automation rules + script actions, use those first.

---

## Consequences

### Positive

- **Zero-code module addition.** A new business module is a seed SQL file. It can be written, reviewed, and deployed in hours, not days. A developer who understands the engine can deliver a functional HRMS module without writing a single TypeScript file.

- **Runtime customisation without deployment.** Tenants add custom fields, modify workflows, create automation rules, and edit notification templates at runtime. No code changes. No deployment window. No engineering involvement.

- **The engine is the product.** Every improvement to the engine (new trigger type, new field type, new condition operator) benefits every module and every tenant simultaneously. Engineering effort compounds.

- **UI comes for free.** Because entity list views, detail pages, and forms are driven by `entity_fields` configuration, every new entity type gets a functional UI immediately — no frontend work required for standard views.

- **Consistent audit trail.** Because all business operations go through the engine's API, every mutation is captured in `workflow_events` and `admin_audit_log` automatically. Module code cannot accidentally bypass auditing.

### Negative and mitigations

- **Engine constraints are real.** A requirement that genuinely cannot be expressed as config requires an engine PR — not a module workaround. This is slower in the short term. Mitigation: the engine is designed conservatively and covers ~95% of real business processes. The script action handles the remainder.

- **Seed SQL is less familiar than TypeScript.** Some engineers instinctively reach for code. Mitigation: this ADR and the config-first checklist above. The module seed runner makes it easy to see and test the resulting entity/workflow definitions.

- **Generic UI has limits.** The generic entity detail view is appropriate for most cases, but complex UI (e.g., a Kanban board, a Gantt chart, a pipeline view with drag-and-drop) needs custom frontend work. Mitigation: the generic views handle 80% of surfaces. Custom views are added as React components alongside the seed SQL, still consuming the engine's API. The engine code is unchanged.

- **Cross-module workflows are constrained.** Modules communicate through the event bus and the entity relation API — not through direct imports. A workflow transition in the CRM cannot directly mutate an HRMS record. It publishes an event; the HRMS automation rule handles it. This is deliberate: it enforces the dependency rule and ensures module isolation.

---

## Implementation notes for seed SQL format

Each module ships a seed SQL file in `modules/{module-name}/seed/`:

```
modules/
  helpdesk/
    seed/
      001_entity_types.sql      -- entity_types + entity_fields INSERT statements
      002_workflow.sql           -- workflows + workflow_states + workflow_transitions
      003_automation_rules.sql   -- automation_rules defaults
      004_view_configs.sql       -- view layout config (optional)
```

The module seed runner applies these files in order when a module is installed for a tenant. It substitutes `{TENANT_ID}` and `{MODULE_ID}` placeholders at runtime.

Platform-defined entity types (available to all tenants, not overridable) have `tenant_id = NULL` in their seed SQL. Tenant-installed entity types have the tenant's ID.

---

## Open Questions

| ID        | Question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Phase      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **CF-01** | ~~What is the process for a module to define "system fields"...~~ **Resolved (2026-08-24):** `is_system` is set exclusively by a module's seed SQL at install time (e.g. `modules/helpdesk/seed/001_entity_types.sql`). The field-creation API (`create-field.ts`) hardcodes `isSystem: false` for every tenant-created field, so tenants can never mark a field system-owned. `updateEntityField`/`deleteEntityField` both reject any mutation of a system field with `SYSTEM_FIELD_IMMUTABLE` — no override mechanism exists, for anyone. If a future admin-override need arises, that requires new, explicit design, not a CF-01 follow-up. | Phase 2 ✅ |
| **CF-02** | Still open (confirmed 2026-08-24): `uninstallModule` (`apps/api/src/services/module-service.ts`) only removes the slug from `tenant.config.installed_modules` — it never touches `entity_types`, `entity_instances`, `workflows`, or any module-created rows. Data silently persists untouched (reinstall re-runs seed SQL against data that never went away, per issue #171's idempotency work). This is real, shippable behavior but an implicit, undocumented one — not a deliberate contract. Still needs an explicit product decision.                                                                                                    | Phase 2    |
| **CF-03** | Still open (confirmed 2026-08-24): `modules.version` is write-only metadata — `installModule` has no version-diffing logic; it just runs every seed file if the tenant doesn't already have the module installed, and does nothing further if already installed. No delta/migration model exists. Matches the ADR's original wording almost exactly — unchanged.                                                                                                                                                                                                                                                                               | Phase 2    |
| **CF-04** | Still open, and downstream of CF-03 (confirmed 2026-08-24): no precedence/merge logic exists anywhere. Since there's no delta-apply mechanism at all yet (CF-03), there's also no code path where a module update and a tenant customization could even collide — this question can't really be resolved until CF-03 is.                                                                                                                                                                                                                                                                                                                       | Phase 2    |
