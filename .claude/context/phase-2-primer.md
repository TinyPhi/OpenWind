# Phase 2 Context Primer

Load this file when working on any Phase 2 feature (platform services, module system, UI).

**Phase 2 goal:** Helpdesk, reimbursements, and CRM live for pilot customers.
Modules are pure config. No module-specific backend TypeScript.

---

## The module system (2B)

A **module** is a named set of seed SQL files that configure the three engines for a
business domain. The platform applies them once per tenant at install time.

```
modules/<name>/
  001_entity_types.sql    # INSERT rows into entity_types + entity_fields
  002_workflow.sql         # INSERT rows into workflows/states/transitions
  003_automation_rules.sql # INSERT rows into automation_rules
```

**Seed runner:** `packages/db/src/seed-runner.ts` reads the SQL files, substitutes
`{TENANT_ID}` with the actual tenant UUID, and runs them in a transaction.

**Module install flow:**

1. Admin calls `POST /admin/tenants/:id/modules/:moduleSlug/install`
2. API looks up module in `modules` table, runs seed SQL via seed runner
3. Sets `tenant_config.installed_modules[]` flag
4. Publishes `module.installed` event

**Module uninstall:** Sets flag to false, data retained. No seed SQL removed.

---

## Platform services (2A)

### Notifications (`@platform/notifications`)

Wraps Novu. Automation engine's `notify` action calls `sendNotification(tenantId, userId, templateId, payload)`.
Template IDs are defined in Novu (not TypeScript). No platform DB table for templates.

### Files (`@platform/files`)

- Upload: `POST /files` → validates tenant, writes to `{tenantId}/{moduleSlug}/{entityId}/filename`, records in `files` table
- Download: `GET /files/:id` → validates tenant owns the file, returns presigned URL (never public URL)
- File table is tenant-scoped with RLS. Quota enforced from `tenant_config.storage_quota_mb`.

### Audit log (`@platform/audit`)

- Table: `admin_audit_log` — append-only, no UPDATE/DELETE RLS policy
- Written by middleware on every entity mutation (create, update, delete, transition)
- Read API: `GET /admin/audit?tenantId=&actorId=&resourceType=&from=&to=`

### View configs

`view_configs` table stores per-entity-type, per-tenant UI layout as JSONB:

- `list_columns` — which fields to show in list view, order
- `detail_layout` — field groups for the detail panel
- `form_field_order` — field order in create/edit forms
  Module seed SQL sets sensible defaults. Tenants can override via `PATCH /admin/view-configs/:id`.

---

## UI layer (2C/2D)

### Admin UI (`apps/admin-ui`)

Refine + shadcn/ui. Reads `view_configs` to render generic entity list/detail/form views.
One generic `<EntityList>`, `<EntityDetail>`, `<EntityForm>` component serves all module entities.

### Customer portal (`apps/portal`)

Same pattern as admin UI but for end-users. Role-gated views based on JWT claims.

### No-code builders (2D)

- Automation builder: CRUD UI for `automation_rules` rows (trigger type, condition tree, action config)
- Workflow editor: visual graph editor writing to `workflows`/`workflow_states`/`workflow_transitions`
- Metabase: embedded via iframe, pointed at analytics read replica

---

## Priority order for Phase 2

1. **2A** platform services (blocks 2C — UI needs notifications + files)
2. **2B** module seeds for helpdesk, reimbursements, CRM (pilot modules)
3. **2C** portal + agent UI (generic views)
4. **2D** no-code builders (can ship after pilot onboarding)

Pilot customer gate: penetration test (tenant isolation) must pass first.
See `docs/sup-docs/roadmap-tracker.md` for current status.
