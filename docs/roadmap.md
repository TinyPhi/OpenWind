# Platform Build Roadmap

**Status:** Active  
**Last updated:** 2026-05  
**Governed by:** [ADR-004 — Config-First Module Design](decisions/ADR-004-config-first-module-design.md)

**Phase 3 lettering note (found during ADR-009 review, 2026-08):** this doc's own 3D/3E split
(§3D "Advanced Workflow Builder", §3E "Observability & Compliance") has drifted from
`CLAUDE.md`/`docs/sup-docs/roadmap-tracker.md`, which are updated every session and call the
observability/compliance track "3D" with no separate lettered "Advanced Workflow Builder" track
(its Core content — the drag-and-drop visual workflow builder — shipped as part of Phase 2D,
2026-07-22). Treat `CLAUDE.md`/`roadmap-tracker.md` as authoritative for phase IDs; this doc's
letters below are unchanged from their original 2026-05 draft.

This document is the sequenced build plan for the platform. It is a living document — updated as phases complete and priorities shift. The [architecture brief](architecture-brief.md) is the stable design reference; this document is the execution plan derived from it.

---

## Governing principle: config over code

The engine layer is written once. Modules are configuration of it — seed SQL files containing entity type definitions, field definitions, workflow definitions, and automation rules. No module-specific backend TypeScript.

**The test:** A new business module (e.g., "Asset Tracking") should require zero new backend code. Only seed SQL rows and optional React UI views.

See [ADR-004](decisions/ADR-004-config-first-module-design.md) for the full decision, consequences, and escape hatches.

---

## Phase 1 — The Unbreakable Foundation

**Duration:** Weeks 1–8  
**Goal:** A running, multi-tenant platform with no customer-facing features. Every subsequent phase is built on top of this. Engine changes after Phase 1 are expensive — this phase is built slowly and carefully.

**Exit test:** A brand-new module can be fully represented as a seed SQL file with zero code changes to the engine or API.

---

### 1A — Infrastructure, Tenancy & Secrets

| Component                                                                                           | Classification | Notes                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database migrations — `0001_initial_schema.sql`                                                     | **Core**       | Complete ADR-001 schema: all tables, RLS policies, indexes, user grants, in one transactional migration file                                                                    |
| RLS policies on all tenant-scoped tables                                                            | **Core**       | Part of migration 0001. Not deferrable                                                                                                                                          |
| `app_user` / `migration_user` / `analytics_user` grants                                             | **Core**       | Part of Postgres init SQL                                                                                                                                                       |
| PgBouncer in transaction mode                                                                       | **Core**       | `docker-compose.yml` addition                                                                                                                                                   |
| `withTenantContext` middleware wired into Hono request lifecycle                                    | **Core**       | Sets `app.tenant_id` before every handler                                                                                                                                       |
| `tenants` table: id, name, slug, plan, status, config JSONB, timestamps                             | **Core**       | `tenant_config` JSONB is the runtime config surface: locale, timezone, currency, feature flags, installed modules, plan limits, storage quota, IP allowlist, retention policies |
| Tenant lifecycle states in `tenants.status`: `provisioning → active → suspended → deleted`          | **Core**       | Enforced by TenantLifecycle service                                                                                                                                             |
| OpenBao in `docker-compose.yml` (dev mode)                                                          | **Core**       | Replaces `ENCRYPTION_KEY`. Env vars: `OPENBAO_ADDR`, `OPENBAO_ROLE_ID`, `OPENBAO_SECRET_ID`, `OPENBAO_TRANSIT_KEY`                                                              |
| `@platform/secrets` package (OpenBao Transit client wrapper)                                        | **Core**       | Envelope encryption for connector credentials. Used by connector runtime in Phase 3                                                                                             |
| `packages/config` env schema updated (remove `ENCRYPTION_KEY`, add OpenBao vars)                    | **Core**       | `.env.example` updated to match                                                                                                                                                 |
| Correlation ID middleware (`x-request-id` on every request, propagated to logs + job metadata)      | **Core**       | Required before any log is useful                                                                                                                                               |
| Global error handler (`apps/api/src/middleware/error-handler.ts`)                                   | **Core**       | Maps domain errors → HTTP status + `{ error, message, fields? }` envelope                                                                                                       |
| Rate limiting middleware (Redis sliding window, per-tenant)                                         | **Core**       | 100 req/min standard, 10 req/min auth endpoints. Per-route override                                                                                                             |
| Tenant provisioning service (create tenant record + seed default entity types + create Zitadel org) | **Core**       | Admin-only endpoint. The mechanism that brings a new customer online                                                                                                            |

---

### 1B — Authentication & Access Control

| Component                                                                             | Classification         | Notes                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zitadel JWKS fetching + JWT signature validation                                      | **Core**               | Replaces placeholder in `packages/auth`                                                                                                                                                         |
| `tenantId` + `roles` claim extraction from validated JWT                              | **Core**               | Zitadel org → tenant mapping                                                                                                                                                                    |
| `requireAuth()` + `requireRole()` middleware wired to all routes                      | **Core**               |                                                                                                                                                                                                 |
| Roles as JWT claim strings (no `roles` table in platform DB)                          | **Core — Config**      | Roles are defined in Zitadel per org. The platform treats them as opaque strings. New roles require zero platform code                                                                          |
| API keys — `api_keys` table (hashed key, tenant_id, name, scopes, last_used_at)       | **Core**               | Machine-to-machine access. Admin CRUD + validation middleware. Schema since extended by ADR-008 (`created_by`, `expires_at`, `revoked_at`/`revoked_by`, `scopes_format` — migrations 0053/0055) |
| Token introspection for sensitive operations (tenant deletion, bulk destructive ops)  | **Important**          | Zitadel introspection endpoint. Not on every request — only where revocation matters                                                                                                            |
| Field-level permissions                                                               | **Important — Config** | Defined as `visible_to_roles[]` in `entity_fields.config`. Enforced by entity engine at read time. No separate permission table                                                                 |
| Support impersonation (platform admin sets tenant context, generates audit log entry) | **Important**          | Admin-only endpoint with mandatory audit trail                                                                                                                                                  |

---

### 1C — Entity Engine

**Config surface:** `entity_types`, `entity_fields`. These rows are what modules ship. The engine interprets them.

| Component                                                                                      | Classification    | Notes                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entity_types` + `entity_fields` admin CRUD API                                                | **Core**          | The config surface. Admin-only                                                                                                                                  |
| Runtime Zod schema generation from `entity_fields` rows                                        | **Core**          | ADR-003 core pattern. Config rows → validation schema at request time                                                                                           |
| Redis schema cache (60s TTL, invalidated on `entity_fields` write)                             | **Core**          | Cache key: `schema:{tenantId}:{entityTypeId}`                                                                                                                   |
| `entity_instances` CRUD API — create, read, update (PATCH), list, soft-delete                  | **Core**          | The data API used by every module and every UI                                                                                                                  |
| Field validation at write time using generated Zod schema                                      | **Core**          | Returns `{ field, error }` per field — never raw DB errors. ADR-003 §validation contract                                                                        |
| Cursor-based pagination on all list endpoints                                                  | **Core**          | Built before any list route is opened. Never offset-based                                                                                                       |
| Filtering + sorting on list endpoints (query params against `fields` JSONB via GIN index)      | **Core**          |                                                                                                                                                                 |
| Soft deletes (`deleted_at` column on `entity_instances`)                                       | **Core**          | No hard deletes in production. Deleted records excluded from all queries by default                                                                             |
| `entity_relations` reverse lookup index (fast "give me all expenses on this project")          | **Core**          | Written on entity create/update when `entity_ref` fields are set                                                                                                |
| Custom tenant fields on module-defined entity types                                            | **Core — Config** | Tenants INSERT rows into `entity_fields` with their `tenant_id`. Engine includes them automatically. `allow_custom_fields` flag on `entity_types` controls this |
| Full-text search on entity instances (Postgres `tsvector` column, GIN index, updated on write) | **Core**          | `GET /entities?q=...` route. Covers 12+ months of search needs without Typesense                                                                                |
| Bulk operations — bulk create, bulk update, bulk soft-delete                                   | **Important**     | Required for import flows and batch automations                                                                                                                 |
| Formula field evaluation (`quickjs-emscripten` sandbox)                                        | **Important**     | Evaluated at read/write time when source fields change. Security-critical: no Node.js globals                                                                   |
| Lookup field resolution (reads across `entity_relations` at query time)                        | **Important**     |                                                                                                                                                                 |
| Tenant isolation test suite for entity engine                                                  | **Core — Tests**  | Every entity endpoint covered. Runs on every PR touching `packages/db/` or `apps/api/`                                                                          |

---

### 1D — Workflow Engine

**Config surface:** `workflows`, `workflow_states`, `workflow_transitions`. The engine is ~400 lines of TypeScript. Modules ship workflow definitions as seed SQL rows.

| Component                                                                                                                     | Classification         | Notes                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `workflows` + `workflow_states` + `workflow_transitions` admin CRUD API                                                       | **Core**               | The config surface. Admin and workflow builder UI write here                                                                           |
| `executeTransition()` — pessimistic lock, role guard, condition eval, state write, event log, outbox — all in one transaction | **Core**               | Per ADR-002 spec. The single function that executes all workflow operations                                                            |
| Condition expression evaluator (JSON rule tree → boolean)                                                                     | **Core**               | ADR-002 grammar: AND/OR/NOT, comparison ops, `role_is`, `is_null`. ~150 lines                                                          |
| `workflow_events` append-only write (no update/delete endpoints or policies)                                                  | **Core**               | Immutable audit trail                                                                                                                  |
| `getAvailableTransitions()` — single authority for what actor can execute from current state                                  | **Core**               | All UI action buttons call this. Prevents "you clicked an action you couldn't take" errors                                             |
| SLA timer — schedule BullMQ delayed job on state entry, cancel on state exit                                                  | **Core**               | Job ID stored in Redis: `sla:{instanceId}:{state}`                                                                                     |
| SLA breach — job fires, checks state still matches, publishes `workflow.sla_breached` to outbox                               | **Core**               |                                                                                                                                        |
| Workflow versioning — new version = new `workflows` row; existing instances retain their `workflow_id`                        | **Core — Config**      | Version is a new row. No migration. Existing instances unaffected                                                                      |
| `lock_timeout` (5s) → HTTP 409 translation in error handler                                                                   | **Core**               | Issue #3                                                                                                                               |
| Transition idempotency via client-supplied `idempotency_key`                                                                  | **Core**               | Prevents double-transition on client retry                                                                                             |
| Parallel approval pattern — approval sub-entities, automation monitors quorum                                                 | **Important — Config** | The _pattern_ is config: approval entity type + automation rule that checks quorum and fires parent transition. No special engine code |
| Workflow templates — platform-defined rows with `tenant_id = NULL`, tenant "installs" by cloning                              | **Important — Config** | Templates are data. Clone = copy rows with tenant's ID                                                                                 |
| Circular workflow detection (graph reachability check on save)                                                                | **Important**          | Issue WE-07. Validates no workflow with zero reachable terminal states can be saved                                                    |
| Tenant isolation tests for workflow engine                                                                                    | **Core — Tests**       |                                                                                                                                        |

---

### 1E — Automation Engine & Event Bus

**Config surface:** `automation_rules`. Every automation is a row. The engine interprets it. No per-module automation code.

| Component                                                                                               | Classification         | Notes                                                                                                              |
| ------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Outbox poller — worker polls `outbox_events`, publishes to BullMQ, marks delivered                      | **Core**               | The event bus reliability mechanism. Runs in `apps/worker`                                                         |
| `automation_rules` admin CRUD API                                                                       | **Core**               | Config surface. Automation builder UI writes here                                                                  |
| Automation rule executor — BullMQ job: load rule row, eval conditions, execute actions                  | **Core**               | Interpreter for `automation_rules` config                                                                          |
| Trigger types v1: `workflow.transitioned`, `workflow.sla_breached`, `entity.created`, `entity.assigned` | **Core**               | Adding a new trigger type is ~5 lines. No per-module trigger code                                                  |
| Action types v1: `notify`, `set_field`, `transition`                                                    | **Core**               | Each action type is an interpreter for an action config JSON object                                                |
| Automation recursion guard — depth counter in job metadata, default limit 10                            | **Core**               | Issue #3                                                                                                           |
| Dead letter queue — `dead_letter_events` table for rules exhausting retries                             | **Core**               | Issue #5                                                                                                           |
| `automation_executions` log — status, result, error, timing, triggering event                           | **Core**               | Per-tenant debugging. Written on every execution                                                                   |
| Circuit breaker per action type — Redis-backed, pauses action type on N consecutive failures            | **Core**               | Prevents Slack outage from jamming the queue                                                                       |
| Event schema versioning — Zod schemas with `version` field, consumers declare supported version         | **Core**               | `WorkflowTransitionedV1`, etc.                                                                                     |
| Trigger types v2: `field.changed`, `schedule.cron`                                                      | **Important**          | `field.changed` compares old/new field values in the job payload. `schedule.cron` = BullMQ repeatable job per rule |
| Action types v2: `create_entity`, `webhook` (with SSRF protection), `assign`                            | **Important**          | `webhook` checks URL against configurable allowlist before POST. Issue #2                                          |
| Script action (`isolated-vm` sandbox, 500ms timeout, `platform.*` safe API)                             | **Important**          | Security-critical. No Node.js globals. The 5% escape hatch for complex logic                                       |
| Automation rule templates — platform rows with `tenant_id = NULL`, tenant clones to customise           | **Important — Config** | Same pattern as workflow templates                                                                                 |

---

### Phase 1 Exit Criteria

- [ ] Entity type, fields, workflow, and automation rule created **via API with no code changes**
- [ ] Entity instance created, validated against field config, transitioned through workflow
- [ ] SLA timers fire; automation rules execute on trigger events
- [ ] A new module representable as seed SQL only — zero new TypeScript required
- [ ] Tenant A cannot read Tenant B's data under any query pattern, verified by isolation test suite
- [ ] Isolation test suite runs on every PR touching `packages/db/` or `apps/api/`
- [ ] Core engine coverage ≥ 80%
- [ ] OpenBao running in docker-compose dev mode; no plaintext `ENCRYPTION_KEY` in env

---

## Phase 2 — First Customer-Ready Apps

**Duration:** Weeks 9–16  
**Goal:** Helpdesk, reimbursements, CRM live for pilot customers. Modules are pure config — seed SQL + optional UI views. No module-specific backend code.

**Exit test:** A penetration test (tenant isolation) passes before any pilot customer is onboarded.

---

### 2A — Platform Services

| Component                                                                                                                      | Classification         | Notes                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------ |
| Notifications: Novu wired, email + in-app channels active                                                                      | **Core**               | `@platform/notifications` sends via Novu                                                   |
| Notification templates                                                                                                         | **Core — Config**      | Defined in Novu (not TypeScript). Template IDs referenced in automation rule action config |
| User notification preferences                                                                                                  | **Core — Config**      | Stored in Novu. Exposed via `PATCH /users/me/preferences`. No platform DB table            |
| Files: `POST /files` — tenant-scoped S3 path (`{tenantId}/{moduleId}/{entityId}/`), metadata in `files` table (RLS)            | **Core**               |                                                                                            |
| Files: `GET /files/:id` — validate tenant owns file, return presigned URL                                                      | **Core**               |                                                                                            |
| File storage quota enforcement                                                                                                 | **Core — Config**      | `tenant_config.storage_quota_mb`. Checked at upload                                        |
| Virus scanning on upload (async, quarantine on positive)                                                                       | **Important**          | ClamAV or cloud scan service                                                               |
| `admin_audit_log` table — append-only, immutable (no UPDATE/DELETE RLS policy), written by middleware on every entity mutation | **Core**               | Issue #5. Compliance requirement                                                           |
| Audit log read API — filterable by tenant/actor/resource/action/date range                                                     | **Core**               | Read-only                                                                                  |
| OpenAPI spec (`@hono/zod-openapi`) — auto-generated from existing Zod validators                                               | **Important**          | No duplication. Spec generated at build time                                               |
| `view_configs` table — per entity type, per tenant: list columns, detail layout, form field order (JSONB)                      | **Core — Config**      | UI reads this to render generic views. Module seed SQL sets defaults                       |
| Saved views / filters — `saved_views` table: user_id, entity_type_id, filter JSONB, sort JSONB                                 | **Important — Config** |                                                                                            |
| Export (CSV, Excel) on any entity list                                                                                         | **Important**          | Generic — uses entity engine list query                                                    |

---

### 2B — Module System

| Component                                                                                                                           | Classification    | Notes                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `modules` table: id, name, slug, version, is_system, min_plan                                                                       | **Core**          | Platform-defined module registry. `is_system = true` for always-on modules                                   |
| Module install per tenant — sets `tenant_config.installed_modules[]`, runs module seed SQL                                          | **Core**          | Install = one-time seed application for the tenant                                                           |
| Module seed runner — applies `001_entity_types.sql`, `002_workflow.sql`, `003_automation_rules.sql` with `{TENANT_ID}` substitution | **Core**          | The mechanism that makes modules pure config                                                                 |
| Module uninstall — deactivates module flag; data retained unless tenant explicitly requests erasure                                 | **Core**          | See open question CF-02 in ADR-004                                                                           |
| Module versioning / delta migrations (seed runner applies delta for installed modules on module update)                             | **Important**     | Open question CF-03 in ADR-004                                                                               |
| Admin module management UI — enable/disable per tenant                                                                              | **Core**          | Refine page reading `modules` + `tenant_config`                                                              |
| Feature flags per tenant                                                                                                            | **Core — Config** | `tenant_config.feature_flags: { [flag]: boolean }`. Evaluated in middleware. No deployment to gate a feature |

**Standard module seed files (all config — zero backend TypeScript):**

| Module                    | Entity types                        | Workflow                                                                                                                           | Notes                                                                             |
| ------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `@modules/helpdesk`       | Ticket, Comment, Article            | Open → In Progress → Pending → Resolved + SLA                                                                                      | Email-to-ticket handled via connector (Phase 3)                                   |
| `@modules/reimbursements` | Expense Claim, Receipt              | Draft → Submitted → Manager Review → Finance Review → Paid                                                                         | Multi-level approval via approval sub-entities                                    |
| `@modules/crm`            | Contact, Company, Deal, Activity    | Lead → Qualified → Proposal → Won / Lost                                                                                           | Pipeline view is custom frontend (kanban)                                         |
| `@modules/projects`       | Project, Task, Milestone            | Backlog → In Progress → In Review → Done                                                                                           | Kanban view is custom frontend                                                    |
| `@modules/hrms`           | Employee, Department, Leave Request | Draft → Submitted → Approved / Rejected                                                                                            |                                                                                   |
| `@modules/invoicing`      | Invoice, Quote, Payment             | Draft → Sent → Paid / Overdue / Cancelled                                                                                          |                                                                                   |
| `@modules/procurement`    | Purchase Order, Vendor, RFQ         | Draft → Approved → Sent → Fulfilled                                                                                                |                                                                                   |
| `@modules/tender`         | Tender                              | Draft → BOQ Preparation → Pending Costing Review → Costing Approved → Document Preparation → Pending Submission Review → Submitted | 8th module, added post-launch (ADR-005, accepted 2026-07-23), category `optional` |

---

### 2C — Customer Portal & Agent UI

These UIs are **driven by entity engine config** — one set of generic components serves all modules.

| Component                                                                         | Classification | Notes                                                                                           |
| --------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------- |
| Generic entity list view — columns driven by `view_configs`, data from entity API | **Core**       | One component. Helpdesk ticket list = this component filtered to `entity_type = ticket`         |
| Generic entity detail view — field layout driven by `view_configs`                | **Core**       | One component. Field order, section grouping, editability all from config                       |
| Generic entity create/edit form — fields generated from `entity_fields` config    | **Core**       | One component. Required, type, options, validation all from config                              |
| Workflow action buttons — driven by `getAvailableTransitions()` response          | **Core**       | Generic component. Buttons appear/disappear based on engine response. No per-module button code |
| In-app notification inbox                                                         | **Core**       | Novu React component or custom inbox wired to Novu                                              |
| Customer-facing ticket portal (restricted to customer's own records)              | **Core**       | Thin shell on generic entity views. Auth scope limits visible records                           |
| Kanban board view (CRM pipeline, Projects task board)                             | **Important**  | Custom frontend — generic list cannot express drag-and-drop columns. Still consumes entity API  |

---

### 2D — No-Code Builders & Reporting

| Component                                                                                    | Classification         | Notes                                                                                                   |
| -------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------- |
| No-code automation rule builder UI                                                           | **Core**               | Writes to `automation_rules` table. The engine already interprets it. Builder is purely a config editor |
| Workflow visual editor — view states/transitions, edit labels/SLAs/role guards               | **Core**               | Reads/writes `workflow_states` + `workflow_transitions`. Engine is unchanged                            |
| Metabase embedded — docker-compose service, per-tenant signed embedding tokens, read replica | **Important**          | Per architecture brief §8.11. Per-tenant row filters via Metabase signed tokens                         |
| Scheduled reports                                                                            | **Important — Config** | Metabase feature once deployed                                                                          |

---

### Phase 2 Exit Criteria

- [ ] Pilot customer submits tickets via portal; agents manage with full SLA enforcement
- [ ] Expense claim approval chain runs end-to-end with role gating
- [ ] Installing a new module requires only a seed SQL file — no code changes
- [ ] Notification templates editable in Novu without deployment
- [ ] Export working on all entity types
- [ ] Penetration test (tenant isolation) passed before pilot customer receives credentials
- [ ] Audit log capturing all entity mutations; viewer functional in admin UI

---

## Phase 3 — Scale, Integrations & Extensibility

**Duration:** Weeks 17–28  
**Goal:** Connector marketplace, plugin system, visual drag-and-drop workflow builder, AI layer, first sector package. Platform extensible by third parties.

---

### 3A — Integration Layer

**Superseded by ADR-008/ADR-009/ADR-010 (all accepted 2026-08-06) and
`.claude/context/phase-3-primer.md` for anything they cover** — this table predates all three
and has not been reconciled line-by-line. Treat the primer + those ADRs as authoritative for
current sequencing, connector priority, and scope; this table is kept for historical context and
for items the ADRs don't touch. Known contradictions are corrected inline below; there may be
others.

| Component                                                                                                             | Classification | Notes                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Webhook gateway: `POST /webhooks/{connectorId}/{tenantId}` — HMAC validation, trigger transform, publish to event bus | **Core**       |                                                                                                                                                                                                  |
| Outbound webhook executor (automation `webhook` action type) with SSRF protection                                     | **Core**       | URL allowlist check before POST. Issue #2                                                                                                                                                        |
| Connector runtime — credential decrypt via OpenBao Transit, `ConnectorContext` injection                              | **Core**       | Connector code never sees raw secrets                                                                                                                                                            |
| OAuth token refresh (transparent via `ConnectorContext`)                                                              | **Core**       | Superseded by ADR-009 Decision #4 — v1's two connectors don't need it (WhatsApp uses a long-lived token, email/IMAP uses basic auth); `ctx.callApi()` keeps the seam for future OAuth connectors |
| Connector polling scheduler (BullMQ repeatable job per connector per tenant)                                          | **Core**       | Defined by `TriggerDefinition.polling` config                                                                                                                                                    |
| Action type: `connector.action` in automation engine                                                                  | **Core**       | Automation rule calls installed connector's defined action                                                                                                                                       |
| Connector install/uninstall flow (`onInstall`/`onUninstall` hooks)                                                    | **Core**       |                                                                                                                                                                                                  |
| Connector marketplace UI — browse, install, configure                                                                 | **Core**       | Reads `connector_definitions` table. Install = create `connector_credentials` row                                                                                                                |
| Built-in connector: email (SMTP/IMAP) — email-to-entity-instance                                                      | **Core**       | `@platform/connector-email`. ADR-009 Decision #2: v1 pair with WhatsApp below                                                                                                                    |
| Built-in connector: WhatsApp Business                                                                                 | **Core**       | ADR-009 Decision #2: v1 pair with email above (corrected — an earlier draft had this row under Important and Slack under Core)                                                                   |
| Built-in connectors: Slack, Stripe, QuickBooks                                                                        | **Important**  | Each is a `ConnectorDefinition` object — no backend routing code. Slack corrected from Core (ADR-009 defers it alongside Stripe/QuickBooks, not WhatsApp)                                        |
| Connector DPA framework — per-connector data processing metadata rows                                                 | **Important**  | Issue #6                                                                                                                                                                                         |
| iPaaS bridge (Trigger.dev) for long-running flows                                                                     | **Optional**   | Launched from `script` action type when needed                                                                                                                                                   |

---

### 3B — Plugin System

| Component                                                                                                              | Classification | Notes                                    |
| ---------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------- |
| `installed_plugins` table: tenant_id, plugin_id, version, status, manifest JSONB                                       | **Core**       | Plugin lifecycle status column           |
| Plugin lifecycle service: resolve deps → validate permissions → run migrations → register routes/hooks/jobs → activate | **Core**       |                                          |
| Plugin permission validation against `tenant_config.plan`                                                              | **Core**       |                                          |
| Plugin Postgres schema namespace isolation per plugin                                                                  | **Core**       |                                          |
| Module Federation host setup — shared deps declared, plugin remotes loaded at runtime                                  | **Core**       |                                          |
| `<Slot>` component with error boundaries — per slot, per plugin                                                        | **Core**       | Plugin UI error cannot propagate to host |
| Plugin error isolation — failures → `plugin_errors` table, not platform crash                                          | **Core**       |                                          |
| Plugin uninstall (deregister + optional migration rollback)                                                            | **Core**       |                                          |
| `@platform/plugin-sdk` published as consumable package                                                                 | **Core**       |                                          |
| SRI hash validation for plugin `remoteEntry.js`                                                                        | **Important**  | Issue #6                                 |
| Plugin health dashboard in admin UI                                                                                    | **Important**  |                                          |
| Plugin developer documentation                                                                                         | **Important**  |                                          |

---

### 3C — AI Layer

| Component                                                                                                                         | Classification | Notes                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------- |
| Automation rule generation from natural language — "send Slack when expense > ₹10k" → rule config JSON. Admin reviews before save | **Core**       | Claude generates `automation_rules` row config. Human confirms                                |
| Workflow suggestion for new entity type — Claude suggests states/transitions from entity name + fields                            | **Core**       | Admin edits the suggestion in the workflow builder                                            |
| Entity classification + field extraction (inbound email → entity instance with fields populated)                                  | **Important**  | Used by email connector                                                                       |
| RAG pipeline for helpdesk draft responses (vector store + retrieval against `knowledge_base_articles`)                            | **Important**  |                                                                                               |
| Per-tenant AI usage metering + rate limiting                                                                                      | **Core**       | All Claude calls logged with token count + estimated cost. Per-plan limits in `tenant_config` |
| AI anomaly detection automation trigger (`ai.anomaly_detected` trigger type)                                                      | **Optional**   | Model runs async, publishes event if threshold exceeded                                       |

---

### 3D — Advanced Workflow Builder

| Component                                                  | Classification         | Notes                                                                                                       |
| ---------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| Drag-and-drop visual workflow builder                      | **Core**               | Reads/writes same `workflow_states` + `workflow_transitions` rows the engine already uses. Engine unchanged |
| Workflow template library UI — browse, preview, clone      | **Core**               | Templates are platform rows. Clone = copy rows with tenant ID                                               |
| Parallel approval config UI                                | **Important**          | Visual representation of approval sub-entity pattern                                                        |
| White-label: per-tenant branding, custom domain            | **Important — Config** | `tenant_config.branding: { logo, primaryColor, domain }`. CSS variables + DNS CNAME config                  |
| First sector package (chosen from pilot customer vertical) | **Important — Config** | Entity types + workflows + automations + sector connectors — all seed SQL                                   |

---

### 3E — Observability & Compliance (runs from Phase 1 onward)

| Component                                                                    | Phase to start | Classification         | Notes                                                       |
| ---------------------------------------------------------------------------- | -------------- | ---------------------- | ----------------------------------------------------------- |
| Correlation ID propagation                                                   | Phase 1        | **Core**               | Every request, every job, every log line                    |
| OpenTelemetry tracing (API → worker → automation → DB spans)                 | Phase 1        | **Important**          | Auto-instrumentation for Hono + Drizzle + BullMQ            |
| Prometheus metrics + `/metrics` endpoint                                     | Phase 2        | **Important**          | API latency, error rates, queue depths, per-tenant counters |
| Error tracking (Sentry SDK)                                                  | Phase 2        | **Important**          | Unhandled exceptions with tenant context                    |
| Grafana dashboards                                                           | Phase 2        | **Important — Config** | Dashboard JSON config files                                 |
| Alerting rules                                                               | Phase 2        | **Important — Config** | Grafana alert rules or Prometheus alertmanager config       |
| Tenant usage metering (API calls, storage, AI tokens → `tenant_usage` table) | Phase 2        | **Important**          | Aggregated daily by cron job                                |
| Billing / plan enforcement gates                                             | Phase 2        | **Important**          | Checked in middleware against `tenant_config.plan` limits   |
| GDPR erasure — tenant deletion cascade, verifiable erasure within SLA        | Phase 3        | **Important**          | Issue MT-01                                                 |
| PII masking in logs + `workflow_events.metadata`                             | Phase 2        | **Important**          | Issue #2                                                    |
| Data retention — `pg_cron` jobs for outbox + event archival                  | Phase 2        | **Important — Config** | Retention period from `tenant_config.retention_days`        |
| Per-user GDPR erasure (not just tenant deletion)                             | Phase 3        | **Important**          | Issue #6                                                    |
| Backup + restore (per-tenant logical dump)                                   | Phase 3        | **Optional**           | Enterprise tier SLA                                         |

---

## Phase 4 — Customer-Driven Refinement (ongoing)

From Phase 3 onwards, the roadmap is driven by customer feedback and commercial requirements. Feature requests triage into:

| Request type                                                 | Response time | Engineering involvement                            |
| ------------------------------------------------------------ | ------------- | -------------------------------------------------- |
| New automation rule template                                 | Days          | Config-only. Seed SQL                              |
| New workflow for existing entity type                        | Days          | Config-only. Seed SQL or builder UI                |
| New custom field on existing entity type                     | Minutes       | Tenant does it themselves in field builder         |
| New module (new entity types + workflow)                     | 1–2 weeks     | Seed SQL + optional UI views                       |
| New action or trigger type                                   | 2–4 weeks     | Engine PR. ADR entry. Reviewed by core team        |
| New engine primitive (new field type, new engine capability) | 4–8 weeks     | Engine PR. Full design review. All tenants benefit |

**Capabilities deferred to Phase 4+ (build only on explicit customer demand):**

| Capability                                              | Trigger                                                |
| ------------------------------------------------------- | ------------------------------------------------------ |
| Typesense (faceted search, autocomplete)                | Tenant hits Postgres FTS limits                        |
| LDAP / Active Directory connector                       | First enterprise customer with on-prem IdP             |
| HIPAA / PCI compliance pack                             | First healthcare or fintech customer                   |
| Multi-region data residency                             | First EU customer with residency requirement           |
| Mobile push notifications                               | First module with mobile-first UX                      |
| Long-running saga coordination (Trigger.dev full embed) | When connector flows exceed what script action handles |
| Custom analytics engine (replace Metabase)              | When embedding limits are hit at scale                 |

---

## Dependency Map

```
1A (infra, tenancy, OpenBao, error handler, rate limiting)
1B (auth — Zitadel JWKS, API keys, RBAC)
  │
  └─ both required before any authenticated API route can exist
         │
         ├─ 1C (entity engine)
         │     └─ 1D (workflow engine)
         │           └─ 1E (automation engine + event bus)
         │
         └─ 2A (platform services: notifications, files, audit log)
                │
                └─ 2B (module system + module seed files)
                       │
                       ├─ 2C (customer portal + agent UI — config-driven views)
                       │
                       └─ 2D (no-code builders — write to tables engines already read)

3A (connectors + webhook gateway)
  └─ requires: 1E (event bus), 1A (OpenBao for credential encryption)

3B (plugin system)
  └─ requires: 2B (module system validates the simpler model before plugins extend it)

3C (AI layer) + 3D (visual workflow builder)
  └─ requires: 2C (UI shell), 3A (connectors as AI input sources)

3E (observability + compliance)
  └─ starts: Phase 1 (correlation IDs)
     continues through all phases
```
