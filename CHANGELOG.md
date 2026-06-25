# Changelog

All notable changes to OpenWind are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Changed

- **API error responses** — workflow and entity engine errors now return human-readable `message` fields instead of raw error codes. Affected codes: `INSTANCE_NOT_FOUND`, `TRANSITION_NOT_AVAILABLE`, `TRANSITION_FORBIDDEN`, `TRANSITION_LOCKED`, `CONDITION_NOT_MET`, `REQUIRED_FIELDS_MISSING`, `ENTITY_NOT_FOUND`, `FIELD_VALIDATION_FAILED`, and others. Clients that match on `error` code are unaffected; clients that display `message` directly will see improved copy.

### Added

#### Admin UI

- Full admin application built with Refine + shadcn/ui:
  - Dashboard with KPI cards, module status, workflow counts, and entity-type summary
  - Workflow list with colorful per-row accents, mini state-flow visualisation, and search
  - Workflow detail — KPI strip, fields/states/transitions tables, inline editing
  - Templates (modules) page — install/uninstall modules with search and filter tabs
  - Entity type management — fields CRUD, instance list, instance detail
  - Customer records navigation — per-entity-type record lists with workflow-aware columns
  - Record detail — UX4G two-column layout, available transition buttons (previously broken), colored state badges, activity timeline
  - Dark/light theme with OS-preference detection and manual toggle
  - Responsive design at 900px / 768px / 640px / 480px breakpoints across all pages

#### Portal UI

- Customer-facing portal rebuilt from scratch:
  - Record list with workflow state badges and priority chips
  - Record detail with transition actions, field display, and activity history
  - Record create form with dynamic field rendering
  - Zitadel OIDC auth with role-based redirect (admin/agent → admin-ui, customer → portal)

#### API

- `GET /modules` — list all registered modules with per-tenant installed status
- `POST /modules/:slug/install` — install a module for a tenant (runs seed SQL)
- `POST /modules/:slug/uninstall` — uninstall a module and remove tenant config
- `GET /admin/view-configs/:entitySlug` — fetch view configuration for an entity type
- `POST /admin/view-configs/:entitySlug` — install default view configs
- `PATCH /admin/view-configs/:entitySlug` — override layout configuration
- `GET /platform/roles` — list Zitadel roles for the organisation
- `GET /platform/users` — list tenant users with display names
- `PATCH /workflows/:id` — update workflow name and active state
- `is_active` field on workflows — toggle workflows active/inactive (portal filters to active only)

#### Database

- Migration 0008 — `modules` table with RLS (tenant-scoped module registry)
- Migration 0009 — `view_configs` table with RLS (per-tenant layout overrides)
- Migration 0010 — `email` and `display_name` columns on `tenant_users`
- Migration 0011 — `is_active` boolean column on `workflows` (default `true`)

#### Modules (seed SQL)

- `helpdesk` — tickets, comments, articles, SLA workflow, automation rules, view configs
- `crm` — contacts, companies, deals, pipeline workflow
- `hrms` — employees, departments, leave requests workflow
- `reimbursements` — expense claims, approval workflow
- `projects` — tasks, milestones, project workflow
- `invoicing` — invoices, quotes, payment workflow
- `procurement` — purchase orders, vendor management, approval workflow

### Fixed

- Workflow transitions were never fetched or rendered in the customer record detail page
- Module seed registry was not auto-populated on first list request
- Helpdesk seed rewritten as a single DO block to fix install errors on Postgres simple protocol
- Type cast errors in seed SQL for Postgres simple protocol

---

## [Unreleased — modular]

### Added

#### Admin UI — RBAC & access control

- **Role-based route guards** — `RequireAdmin` component wraps admin-only routes (`/users`, `/entity-types`, `/workflows` list/create); non-admin users are redirected to `/dashboard` instead of seeing a blank page or a 403
- **Workflow settings access for assignees** — users assigned to a workflow can now open its settings page; access is checked inside the component (admin or workflow assignee)
- **Templates page** — available to all authenticated users (previously admin-only); agents and customers can browse installed modules
- **Settings page** — accessible to all authenticated users; was previously gated too aggressively
- **Dashboard highlight** — active module cards are visually highlighted; the dashboard now surfaces the user's assigned workflows

#### Admin UI — User assignment

- **Searchable user picker** — `UserPicker` component with async search, avatar initials, and role badges; used for assigning users to entity instances
- **Assigned-to field** — create and edit forms surface the assignee picker; workflow records list shows the assigned user
- **Always-visible "New record" button** — previously hidden when no records existed; now always shown

#### Admin UI — Workflow detail

- **Workflow assignee field** — workflow settings page exposes an assignee picker so workflows can be owned by a specific user
- **Template preview modal** — clicking a template card opens a modal showing states, transitions, and field definitions before install
- **Dirty-state navigation guard** — leaving the workflow settings page with unsaved changes triggers a browser confirmation prompt (`useBlocker`)

#### Admin UI — Layout & UX

- **Records sidebar nav item** — links to `/records` alongside Automations, Workflows, and Templates
- **Full-width activity section** — record detail activity feed spans the full panel width for better readability
- **User-picker dropdown portal** — dropdown renders via React portal to escape `overflow:hidden` / z-index clipping in scroll containers

#### API

- `GET /platform/users` — filters users by organisation (Zitadel org scope) using the v2 userservice endpoint
- `assigned_to` field support on entity instances — create, update, and list routes accept and return the assignee user ID
- Migration `0020` — `assigned_to TEXT` column on `entity_instances` (nullable, no FK — user IDs are managed by Zitadel)
- Migration `0021` — entity `user_id` columns changed from UUID to TEXT to match Zitadel's string user IDs

#### Portal

- Zitadel OIDC auth — portal now authenticates via the same OIDC flow as admin-ui; role-based redirect sends customers to portal, agents/admins to admin-ui

#### Developer experience

- **Single-command setup** — `setup.sh` / `setup.bat` bootstraps the entire stack from zero: Postgres, Redis, Zitadel (generated at runtime, not committed), migrations, seed data, demo users
- **Modular Zitadel** — Zitadel is no longer inlined in `docker-compose.yml`; it runs as a separate compose project, joined via the `openwind_zitadel` external Docker network. This keeps the identity provider decoupled from the app stack
- **Service name prefixes** — all app containers renamed to `ow-*` (`ow-backend`, `ow-frontend`, `ow-database`, `ow-cache`, `ow-pgbouncer`) for clarity in multi-project Docker environments
- **Bootstrap container** — `Dockerfile.bootstrap` + `bootstrap` compose service runs migrations, seeds, and Zitadel config in one idempotent pass; safe to re-run
- **Configurable host ports** — `POSTGRES_HOST_PORT`, `ADMIN_UI_HOST_PORT` env vars let you remap host ports without editing compose files (useful when defaults conflict with other local services)

### Changed

- `docker-compose.yml` — Zitadel service removed from main compose; `openwind_zitadel` external network moved to the gitignored `docker-compose.server.yml` overlay so `docker compose up -d` works on a fresh clone with no external network pre-created
- `vite.config.ts` — `allowedHosts` and proxy target are now env-var driven (`VITE_ALLOWED_HOSTS`, `VITE_API_PROXY_TARGET`); neither is set in a default local checkout

### Fixed

- API calls from the admin-ui container now route through the Vite proxy (`/api`) instead of hitting `localhost:3000` directly (which is unreachable inside Docker)
- User-picker dropdown clipped by scroll containers — fixed with a React portal
- `assigned_to` field rejected UUID validation — relaxed to TEXT to match Zitadel string IDs
- Zitadel service account key parsing — added PKCS#1/PKCS#8 fallback and base64 decode path
- Portal auth redirect loop — portal now correctly identifies customer role and stays on portal routes
