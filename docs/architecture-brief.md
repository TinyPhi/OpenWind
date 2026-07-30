# Platform Architecture Brief

## A Modern, AI-First Business Operating System

**Document type:** Engineering leadership kickoff  
**Status:** For review and execution  
**Scope:** Full platform architecture, tech decisions, build strategy

---

## Table of Contents

1. [The Core Insight](#1-the-core-insight)
2. [What We Are Building](#2-what-we-are-building)
3. [Architecture Overview](#3-architecture-overview)
4. [The Three Engines](#4-the-three-engines)
5. [Multi-tenancy Strategy](#5-multi-tenancy-strategy)
6. [Integration Architecture](#6-integration-architecture)
7. [Plugin System](#7-plugin-system)
8. [Tech Stack — Every Decision with Rationale](#8-tech-stack--every-decision-with-rationale)
9. [AI-First Development Strategy](#9-ai-first-development-strategy)
10. [Module Map](#10-module-map)
11. [Build Phases and Milestones](#11-build-phases-and-milestones)
12. [Team Structure and Ways of Working](#12-team-structure-and-ways-of-working)
13. [Risks and Mitigations](#13-risks-and-mitigations)
14. [Appendix A — Core Schema Reference](#appendix-a--core-schema-reference)
15. [Appendix B — Connector SDK Interface](#appendix-b--connector-sdk-interface)
16. [Appendix C — Plugin Manifest Specification](#appendix-c--plugin-manifest-specification)

---

## 1. The Core Insight

Before any line of code is written, the team must internalize one architectural truth that shapes every decision in this document:

> **A support ticket, an expense reimbursement, a sales deal, a purchase order, a leave request, and a vendor onboarding are all the same thing: a stateful object moving through a defined workflow, emitting events as it transitions, triggering side effects along the way.**

This is not a simplification. It is a precise observation. The differences between these objects are:

- The fields they carry (amount vs subject vs SKU)
- The states they pass through (open/closed vs draft/approved/paid)
- The roles that can move them (agent vs finance team vs manager)
- The automations that fire on transition (notify customer vs post to Slack vs update ledger)

None of those differences require different engines. They require different configuration of the same engine.

Once this is accepted, the entire platform design becomes clear: build three engines well — an Entity Engine, a Workflow Engine, and an Automation Engine — and every "product" the company ships to customers is a configuration file sitting on top of those engines, not a new codebase.

This is how Salesforce works at its core. How ServiceNow works. How Linear works. The difference is that none of them were built with the tools available today, and none of them offer the kind of extensibility and transparency that modern customers expect.

---

## 2. What We Are Building

### 2.1 The Problem

Our customers are businesses with varied operational needs. One needs a helpdesk and CRM. Another needs an expense approval workflow and an HR module. A third needs procurement, vendor management, and project tracking. Today, serving each of these means either:

- Pointing them at Frappe/ERPNext and wrestling with its Python-centric customization model and dated architecture
- Building bespoke solutions per customer, which doesn't scale
- Assembling a patchwork of SaaS tools that don't talk to each other

None of these are sustainable at scale.

### 2.2 The Vision

A **modular, workflow-native business platform** where:

- Every operational process a business runs can be modeled as an entity + workflow + automations
- Modules (CRM, helpdesk, HRMS, procurement, etc.) are installable packages that plug into shared infrastructure
- Third-party systems connect through a standard integration layer, not point-to-point brittle APIs
- Customers can configure their own workflows, fields, and automations without writing code
- The development team ships new capabilities primarily as configuration, resorting to code only when configuration hits a hard ceiling
- AI is a first-class participant in development, not an afterthought

### 2.3 What This Is Not

This is not a low-code/no-code platform in the Airtable or Retool sense. Those tools optimize for prototyping speed at the cost of production robustness. This platform is designed for businesses running real operations at scale — with audit trails, SLA enforcement, multi-currency support, role-based access, and the ability to handle tens of thousands of records per tenant.

This is not an attempt to rebuild Frappe. Frappe's architecture served its era. We are building for the next decade, with tools, patterns, and AI capabilities that simply did not exist when Frappe was designed.

---

## 3. Architecture Overview

The platform has five layers, each with a clear responsibility boundary. Violating these boundaries is a form of technical debt that compounds faster than almost any other kind.

```
┌─────────────────────────────────────────────────────────┐
│                  Customer Applications                   │
│     CRM · Helpdesk · Reimbursements · Procurement       │
│     HRMS · Projects · Sector packages                   │
├─────────────────────────────────────────────────────────┤
│                    Engine Layer                          │
│     Entity Engine · Workflow Engine · Automation Engine  │
├─────────────────────────────────────────────────────────┤
│                  Integration Layer                       │
│   Event Bus · Connector SDK · Webhook Gateway · iPaaS   │
├─────────────────────────────────────────────────────────┤
│                  Platform Services                       │
│   Auth · Notifications · Files · Audit · API Gateway    │
├─────────────────────────────────────────────────────────┤
│                    Infrastructure                        │
│         Postgres · Redis · Object Storage · Search      │
└─────────────────────────────────────────────────────────┘
```

### Layer responsibilities

**Infrastructure** is purely operational. It has no business logic. No module imports from this layer directly — they go through platform services.

**Platform services** are shared by every module. Auth does not know what a ticket is. Notifications do not know what an invoice is. They provide generic, multi-tenant primitives. This layer changes rarely and carefully.

**Integration layer** is the nervous system. Everything that happens inside the platform emits an event. Everything that happens outside the platform arrives as an event. The integration layer is the sole translator between internal and external worlds.

**Engine layer** is the intellectual core of the platform. These three engines encode the business logic of "how things work" without encoding what things are. They are the reason the 10th app takes days to build instead of months.

**Customer applications** are configurations of the engine layer. A CRM is a set of entity types (Contact, Company, Deal), workflow definitions (lead → qualified → won/lost), automation rules (on deal.won: create onboarding ticket), and UI view configs. No new database tables. No new API endpoints. Just configuration.

### 3.1 The Dependency Rule

Dependencies flow strictly downward. A customer application may use the engine layer, platform services, and integration layer. The engine layer may use platform services and infrastructure. Platform services may use infrastructure only.

No layer may import from a layer above it. This is enforced at build time via ESLint import rules. Violations are build errors, not warnings.

---

## 4. The Three Engines

### 4.1 Entity Engine

The Entity Engine is the answer to the question: "What are the things this business works with, and what shape do they have?"

#### Core concept

Every "thing" in the platform — a contact, a ticket, an expense claim, a product, an employee — is an **entity instance** of an **entity type**. The entity type defines the schema. The entity instance holds the data.

Entity types are defined by platform modules (e.g., the CRM module defines a `contact` entity type) or created by customers at runtime (e.g., a customer creates an `asset` entity type with custom fields). Both are first-class citizens.

#### Schema design

```sql
-- Entity types: what kinds of things exist
entity_types (
  id          uuid primary key,
  tenant_id   uuid not null,  -- null = platform-defined (shared)
  name        text not null,  -- 'ticket', 'contact', 'expense_claim'
  plural      text not null,
  icon        text,
  module_id   uuid references modules(id),
  created_at  timestamptz default now()
)

-- Field definitions: what shape each entity type has
entity_fields (
  id              uuid primary key,
  entity_type_id  uuid references entity_types(id),
  tenant_id       uuid,        -- null = module-defined, not overridable
  name            text not null,
  label           text not null,
  field_type      text not null,  -- see field types below
  config          jsonb,          -- type-specific config (options list, validation rules, etc.)
  is_required     boolean default false,
  is_indexed      boolean default false,
  sort_order      int,
  created_at      timestamptz default now()
)

-- Entity instances: the actual data
entity_instances (
  id              uuid primary key,
  entity_type_id  uuid references entity_types(id),
  tenant_id       uuid not null,
  workflow_id     uuid references workflows(id),
  current_state   text not null,
  fields          jsonb not null,   -- validated against entity_type schema
  created_by      uuid references users(id),
  assigned_to     uuid references users(id),
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
)
```

#### Field types

The following field types are supported natively. New types are added to the engine — never hardcoded into modules.

| Type         | Description                            | Config keys                      |
| ------------ | -------------------------------------- | -------------------------------- |
| `text`       | Single-line string                     | max_length, pattern              |
| `longtext`   | Multi-line / rich text                 | format: plain\|markdown\|html    |
| `number`     | Integer or decimal                     | min, max, decimal_places         |
| `currency`   | Monetary amount                        | allowed_currencies               |
| `date`       | Calendar date                          | min, max                         |
| `datetime`   | Date + time with timezone              |                                  |
| `boolean`    | True/false toggle                      |                                  |
| `enum`       | Single select from list                | options: [{value, label, color}] |
| `multi_enum` | Multiple select                        | options: [{value, label, color}] |
| `user_ref`   | Reference to a platform user           | roles filter                     |
| `entity_ref` | Foreign key to another entity instance | entity_type_id                   |
| `file`       | Single file attachment                 | allowed_types, max_size_mb       |
| `files`      | Multiple attachments                   | allowed_types, max_count         |
| `formula`    | Computed from other fields             | expression (sandboxed JS)        |
| `lookup`     | Read from related entity               | entity_ref field + path          |

#### Field validation

All field data is stored as `jsonb`. Before write, a validator reconstructs the full schema from `entity_fields` and validates the incoming payload against it using Zod schemas generated at runtime. Validation errors are returned as structured field-level messages, not raw database errors.

This is a deliberate choice: Postgres constraints enforce referential integrity, but business-level validation (required fields, enum membership, range checks) happens in the application layer where it can return useful error messages.

#### Custom fields per tenant

Customers can add custom fields to any entity type defined by a module, as long as the module permits it (controlled by a `allow_custom_fields` flag on the entity type). Custom fields are stored in the same `fields` jsonb column and are indexed when marked `is_indexed = true`. This is the mechanism that replaces Frappe's DocType customization — no schema migrations needed when a customer adds a field.

#### Relations between entities

Relations are defined as `entity_ref` fields. The Entity Engine maintains a `entity_relations` index table for fast reverse lookups (e.g., "give me all expenses associated with this project"). Cascade behavior on deletion is configurable per relation field.

#### Child tickets (hierarchical sub-tasks)

Any entity instance can have child instances — a special case of `entity_relations` using a dedicated `parent_of`/`child_of` relation type, with the child's own workflow state, assignee, and due date. This is how "break this ticket into sub-tasks" works across modules (used by both Helpdesk and the Tender module's costing/approval sub-tasks). Two limits are configurable per workflow: `max_child_depth` (how many levels of nesting are allowed; `0` disables children entirely) and `max_children_per_parent` (a fan-out cap). Both are enforced with a row lock on the parent at creation/move time to prevent races. Archiving a parent archives its active children in the same operation; the reverse relation edge is cleaned up on both sides so the parent's active-child count stays accurate.

#### Record-level access control

Beyond the tenant/role model, individual records support a finer-grained ACL for cases where a customer needs to share a specific ticket with someone who isn't its assignee — stored as a `__accessUsers` map inside the entity's own `fields` JSONB, with three levels: `read_only`, `read_comment`, `read_write`. Access is granted three ways:

- **Directly** by an admin/agent (`grant`/`revoke`/`update` on the record's ACL)
- **Automatically** for the record's creator and current assignee (always `read_write`)
- **Via request** — a non-privileged user can request access to a record they don't own; the record's owner (or any admin/agent) approves or rejects the request, and the grant is applied atomically with the request's resolution so the two can never diverge

A shared `hasEntityReadAccess` check (creator/assignee/ACL-level lookup, admin/agent bypass) gates every read endpoint that touches a specific record — the record itself, its comments, attachments, children, and event history all apply the same check, returning 404 (not 403) rather than leaking whether a record exists.

#### File attachments

Tickets and comments support file uploads via `@platform/files` — presigned S3-compatible URLs only, never a public bucket, gated by the same record-level access check above and a per-tenant storage quota.

### 4.2 Workflow Engine

The Workflow Engine is the answer to: "How do things move, and who is allowed to move them?"

#### Core concept

Every entity instance lives in exactly one **state** at any point in time. States are defined in a **workflow** attached to the entity type. Moving from one state to another is a **transition**. Transitions have guards (who can trigger them, and under what conditions). Every transition is recorded immutably in a **workflow event log**.

This is a finite state machine, but built for business processes rather than software systems. The critical difference is that business workflows need:

- Role-based transition guards (only a manager can approve)
- Conditional transitions (only if amount > threshold)
- SLA-aware states (escalate if not transitioned within N hours)
- Parallel approval (all of A, B, C must approve)
- Optional transitions that don't require a state change (add a comment, attach a file)

All of these are first-class features of the Workflow Engine.

#### Schema design

```sql
-- Workflow definitions
workflows (
  id              uuid primary key,
  tenant_id       uuid,          -- null = module-defined default
  entity_type_id  uuid references entity_types(id),
  name            text not null,
  initial_state   text not null,
  created_at      timestamptz default now()
)

-- States within a workflow
workflow_states (
  id          uuid primary key,
  workflow_id uuid references workflows(id),
  name        text not null,   -- machine name: 'in_review'
  label       text not null,   -- display: 'In Review'
  color       text,            -- hex for UI badges
  is_terminal boolean default false,
  sla_hours   int,             -- null = no SLA
  sort_order  int
)

-- Allowed transitions between states
workflow_transitions (
  id              uuid primary key,
  workflow_id     uuid references workflows(id),
  from_state      text not null,
  to_state        text not null,
  label           text,               -- 'Approve', 'Reject', 'Escalate'
  allowed_roles   text[],             -- empty = any authenticated user
  conditions      jsonb,              -- evaluated rule tree
  requires_comment boolean default false,
  requires_fields  text[]             -- fields that must be set before transition
)

-- Immutable event log: every transition ever made
workflow_events (
  id          uuid primary key,
  instance_id uuid references entity_instances(id),
  workflow_id uuid references workflows(id),
  from_state  text,
  to_state    text not null,
  triggered_by text not null,   -- 'user' | 'automation' | 'api' | 'system'
  actor_id    uuid references users(id),
  comment     text,
  metadata    jsonb,
  created_at  timestamptz default now()
)
```

#### Transition execution

When a transition is requested:

1. Load the workflow definition and current state from the entity instance
2. Find the matching transition record
3. Evaluate allowed_roles against the requesting user's roles
4. Evaluate conditions (a rule tree evaluated against the current field values)
5. Evaluate requires_fields (all listed fields must be non-null)
6. If all guards pass, write the new state to `entity_instances.current_state`
7. Append an immutable record to `workflow_events`
8. Publish a `workflow.transitioned` domain event to the event bus
9. Return the updated entity instance

Steps 6, 7, and 8 are wrapped in a single Postgres transaction with the outbox pattern (see section 6). If the transaction commits, the event will be delivered. If it rolls back, nothing happened.

#### SLA timer management

When an entity enters a state with `sla_hours` set, a BullMQ delayed job is scheduled for `sla_hours` from the transition time. If the entity is still in that state when the job fires, the Workflow Engine publishes a `workflow.sla_breached` event. The Automation Engine picks this up and executes whatever the customer has configured (escalate, notify, auto-transition).

SLA jobs are cancelled immediately when the entity leaves the state. This is implemented by storing the BullMQ job ID in Redis keyed by `sla:{instance_id}:{state}` and calling `job.remove()` on state exit.

#### Parallel approvals

Some workflows require multiple approvers (e.g., finance + legal must both approve a contract). This is modeled as a `parallel_approval` workflow state with a child `approvals` entity type. The main entity stays in the parallel state until all required approvals are recorded. The Automation Engine monitors the approvals sub-workflow and fires a transition on the parent when the quorum condition is met.

This avoids complex workflow engine internals while remaining fully auditable.

### 4.3 Automation Engine

The Automation Engine is the answer to: "What happens when things move?"

#### Core concept

Every state transition, field update, or external event can trigger a rule. Rules follow a simple structure:

```
WHEN  [trigger]
IF    [conditions] (optional)
THEN  [actions] (one or more)
```

Rules are tenant-scoped, versioned, and executed asynchronously via the event bus. They never run inside the transition transaction — they are consumers of transition events, not participants in them. This means a broken automation rule can never prevent a workflow transition from completing.

#### Trigger types

| Trigger                  | Example                                               |
| ------------------------ | ----------------------------------------------------- |
| `workflow.entered_state` | When ticket enters `escalated`                        |
| `workflow.transitioned`  | When expense transitions from any state to `approved` |
| `workflow.sla_breached`  | When a deal has been in `negotiation` for > 14 days   |
| `field.changed`          | When deal.value exceeds ₹500,000                      |
| `entity.created`         | When a new contact is created                         |
| `entity.assigned`        | When a ticket is assigned to an agent                 |
| `schedule.cron`          | Every Monday at 9am                                   |
| `connector.event`        | When Stripe fires `payment_intent.succeeded`          |

#### Action types

| Action             | Description                                                                 |
| ------------------ | --------------------------------------------------------------------------- |
| `notify`           | Send email, in-app, Slack, WhatsApp via Novu                                |
| `assign`           | Set `assigned_to` using a rule (round-robin, skill-match, load-balance)     |
| `transition`       | Move entity to a new state                                                  |
| `set_field`        | Update a field value (e.g., set `escalated_at` to now)                      |
| `create_entity`    | Create a related entity (e.g., create a follow-up task)                     |
| `webhook`          | POST to an external URL                                                     |
| `connector.action` | Call an action on an installed connector (e.g., create Stripe invoice)      |
| `script`           | Run a sandboxed JS function for logic that can't be expressed declaratively |

#### Script sandbox

The `script` action type runs tenant-authored JavaScript in a V8 isolate (via `isolated-vm`) with a strict 500ms timeout and no access to Node.js globals. The sandbox exposes a `platform` object with safe methods: `platform.getEntity()`, `platform.setField()`, `platform.notify()`, `platform.log()`. This is the escape hatch for customers who need logic beyond what the declarative rule engine can express, without giving them arbitrary server-side code execution.

#### Execution guarantees

Automations are executed as BullMQ jobs. Each job has:

- 3 automatic retries with exponential backoff
- A dead-letter queue for rules that exhaust retries
- Per-tenant execution logging for debugging
- Circuit breaker per action type (if Slack is down, pause Slack actions and retry later)

Automation failures are surfaced in the admin dashboard with the full error, the triggering event, and a one-click "retry" button.

---

## 5. Multi-tenancy Strategy

Multi-tenancy is not a feature — it is a load-bearing architectural decision that affects schema design, query patterns, auth, file storage, job queues, and observability. Getting this wrong in week 1 means refactoring everything in week 20.

### 5.1 Chosen strategy: shared schema with tenant_id isolation

We use a single Postgres database with a `tenant_id` column on every tenant-scoped table, enforced by Postgres Row-Level Security (RLS). This is sometimes called the "shared schema" model.

The alternatives and why we reject them:

**Schema-per-tenant** (e.g., separate `acme.*` and `globex.*` schemas): Simpler conceptually, but catastrophic operationally. Running migrations across 500 schemas means 500 sequential DDL operations. Monitoring requires 500 connection pools. Backup and restore complexity scales linearly with customer count.

**Database-per-tenant**: Maximum isolation but operationally untenable beyond ~20 customers. Pooling, monitoring, and cost become unmanageable.

**Shared schema + RLS** is the approach used by Supabase, PostgREST, and production multi-tenant SaaS at scale. It requires discipline but scales to millions of rows per table without operational overhead.

### 5.2 RLS implementation

Every tenant-scoped table has:

```sql
-- Add tenant_id
ALTER TABLE entity_instances ADD COLUMN tenant_id uuid NOT NULL;

-- Create index (always)
CREATE INDEX ON entity_instances (tenant_id);

-- Enable RLS
ALTER TABLE entity_instances ENABLE ROW LEVEL SECURITY;

-- Policy: application can only see rows matching its tenant
CREATE POLICY tenant_isolation ON entity_instances
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

The application sets `app.tenant_id` at the start of every request via a Postgres connection middleware:

```typescript
// Hono middleware — runs before every handler
app.use("*", async (c, next) => {
  const tenantId = c.get("auth").tenantId; // from validated JWT
  await db.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
  return next();
});
```

This means no query in the application ever needs a `WHERE tenant_id = ?` clause. The database enforces isolation at the row level. A developer cannot accidentally leak tenant data through a missing WHERE clause.

### 5.3 Tenant-scoped configuration

Each tenant has a `tenant_config` table that overrides platform defaults: locale, timezone, currency, branding, feature flags, installed modules, and connector credentials. This is loaded once per request and cached in Redis with a 60-second TTL.

### 5.4 File storage isolation

Every file uploaded is stored at `s3://{bucket}/{tenantId}/{moduleId}/{entityId}/{filename}`. Access is via presigned URLs generated by the platform — the S3 bucket is never publicly accessible. File metadata is in Postgres, subject to RLS. A file belonging to tenant A can never be accessed by tenant B even if the UUID is guessed, because the presigned URL generation validates tenant ownership before signing.

### 5.5 Job queue isolation

BullMQ queues are prefixed by tenant: `{tenantId}:workflow:transitions`, `{tenantId}:automation:executions`. This allows per-tenant rate limiting, per-tenant job monitoring, and prevents a high-volume tenant's job storm from starving other tenants. A global concurrency limit per tenant is enforced at the worker level.

---

## 6. Integration Architecture

### 6.1 Philosophy: event-first, not API-first

The failure mode of most integration architectures is point-to-point coupling. Module A calls Module B's API. Module B calls Module C. When C is down, B is degraded, and A fails. When C's API changes, B breaks, and A breaks.

The event-first approach inverts this. When something happens, it is published as an immutable event. Any interested party subscribes. The publisher does not know who is listening. The subscriber does not need the publisher to be available when it processes the event.

This is the backbone of both internal module communication and external integrations.

### 6.2 The event bus

**Technology:** BullMQ with Postgres outbox pattern

The outbox pattern is non-negotiable for production reliability. The naive approach — publish to BullMQ after a database write — has a fatal flaw: the process can crash after the DB write but before the publish, losing the event silently. The outbox pattern fixes this:

```
1. Begin transaction
2. Write state change to entity_instances
3. Write event to outbox table (same transaction)
4. Commit

5. Background worker polls outbox table
6. Publishes to BullMQ
7. Marks outbox record as delivered
```

Steps 1–4 are atomic. If the transaction commits, the event will eventually be delivered. If it rolls back, no event is emitted. There is no window for silent loss.

```sql
-- Outbox table
outbox_events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  event_type  text not null,   -- 'workflow.transitioned'
  payload     jsonb not null,
  created_at  timestamptz default now(),
  delivered_at timestamptz     -- null = pending
)
```

#### Event schema versioning

Every event type has a version. Events are never mutated in-place — new versions add fields, old fields are never removed until a deprecation window has passed. Consumers declare which version they support in their subscription registration.

```typescript
// Event schema definition (enforced by Zod)
const WorkflowTransitionedV1 = z.object({
  eventType: z.literal("workflow.transitioned"),
  version: z.literal(1),
  tenantId: z.string().uuid(),
  instanceId: z.string().uuid(),
  entityTypeId: z.string().uuid(),
  fromState: z.string(),
  toState: z.string(),
  triggeredBy: z.enum(["user", "automation", "api", "system"]),
  actorId: z.string().uuid().nullable(),
  occurredAt: z.string().datetime(),
});
```

### 6.3 Connector SDK

The Connector SDK is the contract that any third-party integration must implement. It is a TypeScript interface, published as `@platform/connector-sdk`.

```typescript
export interface ConnectorDefinition {
  meta: {
    id: string; // '@platform/connector-stripe'
    name: string; // 'Stripe'
    version: string; // '1.0.0'
    iconUrl: string;
    docsUrl: string;
    category: ConnectorCategory;
  };

  auth: OAuthConfig | ApiKeyConfig | BasicAuthConfig;

  triggers: TriggerDefinition[]; // inbound events from 3rd party
  actions: ActionDefinition[]; // outbound calls to 3rd party

  // Called once when tenant installs the connector
  onInstall?: (ctx: ConnectorContext) => Promise<void>;

  // Called when tenant uninstalls
  onUninstall?: (ctx: ConnectorContext) => Promise<void>;
}
```

A trigger definition specifies:

- How to receive the event (webhook URL, polling config)
- How to validate the incoming payload (HMAC secret, signature header)
- How to transform the raw payload into a canonical platform event

An action definition specifies:

- The action name and parameters (Zod schema)
- The function that executes the action using the tenant's stored credentials
- Retry and rate limit behavior

#### Credential management

OAuth tokens, API keys, and secrets are stored encrypted (AES-256-GCM) in the `connector_credentials` table, scoped per tenant per connector. The SDK handles token refresh transparently. The connector implementation never sees raw secrets — it receives a `ConnectorContext` with a `callApi(config)` helper that injects credentials automatically.

### 6.4 Webhook gateway

**Inbound:** `POST /webhooks/{connectorId}/{tenantId}`

The gateway validates the HMAC signature, looks up the connector definition, calls the trigger's transform function, and publishes the resulting platform event to the event bus. If validation fails, the request is rejected with 401. If the connector is not installed for that tenant, the request is rejected with 404.

**Outbound:** Customer-configured webhook endpoints, managed by the automation engine's `webhook` action type. Outbound webhooks are sent with HMAC signatures so the recipient can verify authenticity. Failed deliveries are retried with exponential backoff. Delivery logs are stored per tenant for 30 days.

### 6.5 iPaaS bridge for complex flows

For multi-step, long-running, or human-in-the-loop integration flows that exceed what the automation engine's declarative model can handle well, we embed **Trigger.dev** as an internal service. The automation engine's `script` action can spawn a Trigger.dev workflow, which can wait for webhooks, sleep for days, branch conditionally, and call multiple external APIs in sequence. This handles flows like: "send a contract to DocuSign, wait for signature, then update the deal, then create a Stripe subscription, then send an onboarding email."

---

## 7. Plugin System

The plugin system is what allows the platform to grow beyond what the core team builds. It must solve two distinct problems: backend extensibility (new data models, API routes, business logic, event handlers) and frontend extensibility (new pages, components injected into existing views). Both must maintain strict isolation — a broken plugin must not be able to crash the platform.

### 7.1 Plugin manifest

Every plugin exports a single manifest file. This is the contract between the plugin and the platform.

```typescript
// plugin.manifest.ts
export const manifest: PluginManifest = {
  id: "@acme/hrms",
  name: "Human Resources",
  version: "1.2.0",
  platformVersion: ">=1.0.0",

  // Dependency declaration — resolved before install
  requires: [
    "@platform/core-users@>=1.0.0",
    "@platform/core-notifications@>=1.0.0",
  ],

  // Permissions requested — validated against tenant plan
  permissions: [
    "db:hrms.*", // schema namespace
    "events:employee.*", // event prefix
    "slots:sidebar.nav", // UI injection points
  ],

  // Backend wiring
  migrations: "./migrations", // Drizzle migration folder
  routes: "./routes", // Hono router, mounted at /api/{plugin-id}
  hooks: "./hooks", // Event subscriptions and middleware hooks
  jobs: "./jobs", // BullMQ worker definitions

  // Frontend wiring
  ui: {
    remote: "https://cdn.platform.com/plugins/hrms@1.2.0/remoteEntry.js",
    slots: [
      { name: "sidebar.nav", component: "HrmsNavItems" },
      { name: "user.profile.tabs", component: "EmployeeProfileTab" },
      { name: "dashboard.widgets", component: "HrmsWidgets" },
    ],
    pages: [{ path: "/hrms", component: "HrmsApp", title: "HR" }],
  },
};
```

### 7.2 Backend extensibility

#### Schema isolation

Each plugin owns its own Drizzle schema under a dedicated Postgres schema namespace (`hrms.*`, `crm.*`, `billing.*`). Plugins may reference core tables via foreign keys, but core tables never reference plugin tables. This is the fundamental rule that prevents circular dependencies.

```typescript
// @acme/hrms/schema.ts
import { pgSchema, uuid, text, date } from "drizzle-orm/pg-core";
import { users } from "@platform/core/schema"; // ✅ allowed — referencing core

export const hrms = pgSchema("hrms");

export const employees = hrms.table("employees", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  employeeCode: text("employee_code").notNull(),
  department: text("department"),
  joiningDate: date("joining_date"),
  tenantId: uuid("tenant_id").notNull(),
});
```

#### Hook types

Plugins communicate with the platform through three hook types:

**Event hooks** — async, fire-and-forget. The plugin subscribes to a platform event and handles it in the background. Failure of an event hook does not affect the originating transaction.

```typescript
// @acme/hrms/hooks.ts
export const hooks: Hook[] = [
  {
    type: "event",
    event: "user.invited",
    handler: async (event, ctx) => {
      // Create employee record when user is invited
      await ctx.db.insert(employees).values({
        userId: event.payload.userId,
        tenantId: event.tenantId,
        employeeCode: await generateEmployeeCode(ctx),
      });
    },
  },
];
```

**Middleware hooks** — synchronous, ordered by priority. Plugins can intercept entity operations before or after they execute. A `before` hook can mutate the payload or throw to abort. An `after` hook enriches the result.

```typescript
{
  type: 'middleware',
  phase: 'before',
  operation: 'entity.create',
  entityType: 'expense_claim',
  priority: 10,
  handler: async (payload, ctx) => {
    // Validate expense against HR policy before creation
    const policy = await getExpensePolicy(ctx.tenantId, ctx.db);
    if (payload.fields.amount > policy.maxSingleExpense) {
      throw new PlatformError('POLICY_VIOLATION', 'Expense exceeds single-claim limit');
    }
    return payload; // must return (potentially mutated) payload
  },
}
```

**Route extensions** — plugins mount a Hono sub-router at `/api/{pluginId}`. The router has full access to the platform's auth context, database connection (scoped to the tenant's schema namespace), and event bus.

#### Plugin isolation and failure handling

Every event hook runs inside a try/catch. Failures are:

1. Logged to the platform's structured log with plugin ID, event ID, tenant ID, and error
2. Written to a `plugin_errors` table for the admin dashboard
3. Retried up to 3 times with exponential backoff (for transient failures)
4. Moved to a dead-letter queue after exhausted retries

A plugin's failure never propagates to the core request lifecycle. The platform continues to function normally. Plugin health is tracked per tenant and surfaced in the admin UI — administrators can see which plugins are healthy, degraded, or failing.

### 7.3 Frontend extensibility

#### Module Federation

Each plugin's frontend is a Webpack/Vite Module Federation remote. The host application (the main React app) declares shared dependencies — React, the design system, routing, auth context — and plugin remotes consume them at runtime without bundling their own copies.

This means:

- Installing a plugin does not require rebuilding the host application
- Plugins always use the correct version of shared dependencies
- A plugin UI that throws a JavaScript error is caught by a React error boundary and shows a degraded state — it does not crash the host app

#### The slot system

The host application declares named injection points — **slots** — where plugin components can appear:

```tsx
// In the main layout — host doesn't know what renders here
<Slot name="sidebar.nav" />
<Slot name="dashboard.widgets" context={{ userId }} />

// In the ticket detail view
<Slot name="ticket.detail.sidebar" context={{ ticketId, tenantId }} />
```

Plugins register into slots at boot time:

```typescript
// @acme/hrms/ui/index.ts
platform.slots.register("sidebar.nav", HrmsNavItems, { priority: 20 });
platform.slots.register("user.profile.tabs", EmployeeTab, { priority: 10 });
```

When the host renders `<Slot name="sidebar.nav" />`, it queries the slot registry and renders all registered components in priority order, each wrapped in an error boundary.

#### Platform UI SDK

The `@platform/ui` package exports the complete design system — components, tokens, icons, hooks — that plugin UIs must use. This ensures visual consistency across core and plugin UIs. Plugins that render their own completely custom styling are technically possible but discouraged and flagged in the partner review process.

### 7.4 Plugin lifecycle management

```
install → resolve → validate → migrate → register → active
                                                    ↓
uninstall ← deregister ← rollback_migrations ← (requested)
```

**Resolve:** Dependency graph is built from all installed plugins. Topological sort determines initialization order. Circular dependencies are rejected before any code runs.

**Validate:** Declared permissions are checked against the tenant's plan. A plugin declaring `db:*` wildcard permissions on a free tenant is rejected. Semantic version compatibility with the platform version is verified.

**Migrate:** Drizzle migrations run in a transaction. If any migration step fails, the entire migration rolls back and the plugin is marked as `install_failed`. The error is surfaced to the admin with the exact SQL that failed.

**Register:** Routes, hooks, jobs, and UI slots are registered in memory. The plugin's remote URL is added to the Module Federation config served to the frontend.

**Active:** Plugin is fully operational. Health checks begin.

**Uninstall:** The uninstall flow is the reverse. Hooks are deregistered. Jobs are drained and stopped. Migrations are rolled back if the plugin supports it (flagged in the manifest). Routes are removed. The UI slots are cleared.

---

## 8. Tech Stack — Every Decision with Rationale

Every technology choice below was made against three criteria: production maturity, TypeScript-first design, and operational simplicity. Tools that require Ruby, Python, or Java are rejected unless there is no viable alternative.

### 8.1 Runtime: Node.js + Bun

**Primary runtime:** Node.js 22 LTS for production workers and API servers. Mature, battle-tested, enormous ecosystem, no surprises.

**Bun for CLI tools and scripts:** Bun's speed advantage is real for short-lived processes (test runners, migration scripts, codegen). It is not yet stable enough to be the primary production runtime for a multi-tenant API.

**Rationale against Deno:** Smaller ecosystem, fewer production case studies at multi-tenant scale. Not worth the risk on a platform that must be reliable.

### 8.2 API framework: Hono

Hono is the correct choice for this platform. It runs on any JavaScript runtime (Node, Bun, Cloudflare Workers, Deno), has first-class TypeScript support, is built around Web Standards (Request/Response), and performs significantly faster than Express or Fastify at equivalent workloads.

The `hono/validator` middleware with Zod provides schema validation at the route level. The `@hono/zod-openapi` package generates OpenAPI specs from the same Zod schemas used for validation — no duplication.

**End-to-end type safety** is achieved via tRPC for internal API calls (frontend ↔ backend, service ↔ service). Public-facing APIs (for customer integrations, mobile apps, webhooks) are RESTful Hono routes with OpenAPI documentation generated automatically.

### 8.3 Database: PostgreSQL 16

There is no serious alternative to Postgres for this platform. It provides:

- Row-Level Security for multi-tenancy
- JSONB with GIN indexes for the entity fields store
- Full-text search adequate for the first 12 months (`tsvector` + `tsquery`)
- `pg_cron` for scheduled maintenance tasks
- `pg_notify`/`LISTEN` for real-time change detection
- Logical replication for read replicas

**Connection pooling:** PgBouncer in transaction mode, or Supavisor if self-hosted on Supabase infrastructure. Never allow the application to open direct connections without pooling in multi-tenant workloads.

**Schema migrations:** Drizzle ORM. Migrations are TypeScript files that generate SQL. Drizzle's push model is used in development; explicit migration files are used in production, committed to version control, reviewed in PRs, and applied by the deployment pipeline.

### 8.4 ORM: Drizzle

Drizzle sits at the right level of abstraction. It is SQL-first, type-safe, and does not hide what queries it generates. When performance matters, you write raw SQL via `db.execute(sql\`...\`)` — Drizzle does not fight you. When rapid development matters, the query builder covers 90% of cases.

Prisma is rejected for this platform: its generated client adds a layer of indirection that makes it difficult to reason about query behavior, and its migration story is weaker than Drizzle's for multi-tenant schema management.

### 8.5 Queue: BullMQ + Redis

BullMQ handles all background work: workflow SLA timers, automation execution, email delivery, webhook retries, connector polling, file processing. It is mature, well-documented, supports priorities and delayed jobs, has a UI dashboard (Bull Board), and integrates natively with Node.js.

Redis serves dual purpose: BullMQ's backend and application-level cache (session data, tenant config, rate limit counters). Redis Cluster is used in production for high availability.

### 8.6 Auth: Zitadel

Zitadel provides the full identity stack: OIDC/OAuth2, SAML, SCIM, MFA, passwordless, organization management, role management, and an audit log. It is deployable as a single binary or Docker container with Postgres as its backend.

Critically, Zitadel's organization model maps directly to our multi-tenant model: each customer is a Zitadel organization. Users belong to organizations. Roles are assigned per organization. This means we do not build auth — we configure Zitadel.

JWT tokens issued by Zitadel carry the `tenantId` and `roles` claims. The Hono middleware validates the token signature (JWKS endpoint), extracts claims, and sets the request context. All downstream code trusts these claims.

**Keycloak** is the alternative. It is more widely deployed in enterprise contexts. The choice between Zitadel and Keycloak should be made based on: Zitadel has a cleaner modern API and better multi-tenant UX out of the box. Keycloak has a larger ecosystem and more enterprise integrations (LDAP, Active Directory). For most customers, Zitadel is the right default. The platform's auth abstraction layer makes it possible to swap the provider if needed.

### 8.7 Notifications: Novu

Novu provides a single SDK for email, SMS, push, Slack, WhatsApp, in-app notifications, and webhooks. It handles template management, delivery, user preferences (e.g., "don't send me Slack messages between 10pm and 8am"), digest batching (e.g., "send one daily digest instead of 50 individual emails"), and delivery analytics.

The automation engine's `notify` action calls Novu. Every module that needs to notify a user calls Novu via the platform notification service — never directly via SendGrid or Twilio. This ensures all notifications are centralized, auditable, and respect user preferences.

### 8.8 Admin UI: Refine

Refine is a React framework for building admin/CRUD applications. It provides: list/detail/edit/create views wired to a data provider, pagination, filtering, sorting, access control integration, and a growing ecosystem of UI component presets.

The platform's admin UI is built on Refine with shadcn/ui components. The design system is Tailwind-based. Refine's data provider is implemented against the platform's tRPC API, so all CRUD operations are fully type-safe end-to-end.

For customer-facing portals (e.g., a helpdesk customer portal, an expense submission form), we use plain React with the same design system. Refine is for internal/admin surfaces only.

### 8.9 Monorepo: Turborepo

All packages — core engines, platform services, standard modules, sector packages, connector SDK, UI packages — live in a single Turborepo monorepo.

```
platform/
├── apps/
│   ├── api/          # Main Hono API server
│   ├── worker/       # BullMQ workers
│   ├── admin-ui/     # Refine admin app
│   └── portal/       # Customer-facing portal shell
├── packages/
│   ├── entity-engine/
│   ├── workflow-engine/
│   ├── automation-engine/
│   ├── connector-sdk/
│   ├── plugin-sdk/
│   ├── ui/           # Design system
│   └── db/           # Drizzle schema + migrations
└── modules/
    ├── crm/
    ├── helpdesk/
    ├── hrms/
    ├── reimbursements/
    └── ...
```

Turborepo's build caching means that unchanged packages are never rebuilt. In CI, this reduces build times from minutes to seconds for iterative changes.

### 8.10 Search: Postgres first, Typesense when needed

Postgres full-text search (`tsvector` + `tsquery`) handles the majority of search needs — entity name lookup, ticket search, contact search. GIN indexes on the `fields` jsonb column handle attribute-based filtering.

When a customer has tens of millions of entity instances and needs fuzzy search, faceted filtering, and instant-results autocomplete, **Typesense** is added as a secondary search index. Typesense is operationally simpler than Elasticsearch (single binary, no JVM, no cluster overhead), has an excellent Node.js SDK, and handles multi-tenant search via per-tenant collections.

We explicitly avoid Elasticsearch. Its operational overhead (JVM memory, cluster management, index management) is a maintenance burden that is not justified for this platform's scale.

### 8.11 Reporting: Metabase embedded

Customer-facing analytics are delivered through Metabase's embedding feature. Metabase is deployed as an internal service with access to a read replica of the platform's Postgres database. Per-tenant row-level filters are enforced at the embedding level via Metabase's signed embedding tokens.

This approach provides:

- Full BI capability (custom queries, charts, dashboards) on day one
- No custom chart development
- Per-tenant dashboard isolation
- Scheduled email reports built-in

For platform-level operational metrics (API latency, error rates, queue depths, tenant health), we use Grafana with Prometheus metrics exported from the API and worker processes.

### 8.12 Deployment: Docker Compose for dev, Kubernetes for production

Development: a single `docker compose up` starts Postgres, Redis, MinIO (local S3), Zitadel, Novu, the API server, workers, and admin UI. Every developer has a fully functioning local environment within 10 minutes.

Production: Kubernetes (managed — EKS, GKE, or DigitalOcean Kubernetes depending on customer requirements). Each service is a Kubernetes Deployment with horizontal pod autoscaling. Secrets are managed via **OpenBao** (the CNCF OSS fork of Vault — API-compatible, actively maintained, zero licensing ambiguity). OpenBao's Transit secrets engine handles envelope encryption for connector credentials (per-tenant DEK encrypted by a KEK that never leaves OpenBao). OpenBao runs as a sidecar/service in the cluster; dev mode runs in `docker-compose` alongside the other services. CI/CD via GitHub Actions → build Docker images → push to registry → apply Kubernetes manifests.

For self-hosted customer deployments, we provide a Helm chart. This is a significant differentiator for enterprise customers with data residency requirements.

---

## 9. AI-First Development Strategy

"AI-first" is not a feature to be added later. It is the development methodology from day one. This section describes both how AI accelerates platform development and how AI capabilities are baked into the platform itself.

### 9.1 AI-assisted development with Claude

The team adopts Claude as the primary AI development partner. This is not about using AI for autocomplete. It is about a systematic, token-heavy approach where Claude participates in:

**Architecture decisions:** Every significant design decision is discussed with Claude before code is written. This surfaces edge cases, alternative approaches, and potential failure modes that would otherwise only emerge in code review.

**Code generation:** Entire modules are scaffolded by Claude with precise prompts. A new entity type with its Drizzle schema, Hono routes, tRPC procedures, Zod validation schemas, and Refine UI views can be generated in a single Claude session. The developer's job becomes reviewing and refining output, not typing from scratch.

**Test generation:** Claude generates comprehensive test suites — unit tests for business logic, integration tests for API endpoints, and migration tests for schema changes — from the same specification used to generate the implementation. Tests are written before implementation is accepted.

**Documentation:** Every module, every public API, and every decision record is documented by Claude as part of the development workflow. Documentation is never an afterthought because it is generated alongside code.

**Code review:** Claude is the first reviewer on every PR, checking for: RLS bypass (queries missing tenant_id), missing error handling, N+1 query patterns, type assertion abuse, and consistency with platform conventions. Claude's review runs in CI as a GitHub Action.

#### Prompt engineering conventions

The team maintains a `/.claude/` directory at the monorepo root with:

- `CONVENTIONS.md` — platform coding conventions that every Claude prompt includes as context
- `prompts/` — reusable prompt templates for common tasks (new module, new connector, new workflow config)
- `context/` — domain context documents that Claude needs for specialized tasks

Every developer prompt for code generation includes the conventions file and the relevant module's existing code as context. This keeps generated code consistent with the platform's patterns.

#### Token budget

The team operates with a generous token budget — this is an investment, not a cost center. The productivity gain from AI-assisted development at this level of systematic integration significantly outweighs the API cost. Token usage is tracked per developer per week to identify where the workflow can be further optimized.

### 9.2 AI capabilities in the platform

Beyond development tooling, AI capabilities are designed into the platform from the start — not added as a plugin. The platform exposes AI through:

**Intelligent entity classification:** When an email arrives or a form is submitted, Claude classifies it into the correct entity type, extracts structured field values, and routes it to the correct workflow. A support email becomes a helpdesk ticket with priority, category, and extracted customer information already populated.

**Workflow suggestion:** When an administrator creates a new entity type, Claude suggests a workflow (states, transitions, SLA rules) based on the entity type's fields and the industry context. The admin reviews and edits rather than designing from scratch.

**Automation rule generation from natural language:** "Send a Slack message to the finance channel when an expense over ₹10,000 is submitted" → Claude generates the automation rule config in the platform's rule schema. The admin reviews and saves.

**Field mapping for connectors:** When a new connector is installed and needs to map its data fields to the platform's entity fields, Claude performs the mapping based on field names and types. It flags ambiguous mappings for human review.

**Anomaly detection:** The automation engine can trigger on AI-detected anomalies — expense claims that deviate significantly from the submitter's history, tickets where sentiment has deteriorated, deals that have been idle longer than similar-stage deals historically.

**Draft responses:** Helpdesk agents see AI-drafted responses to tickets, grounded in the platform's knowledge base. The agent reviews and sends, or edits. Response generation uses RAG (retrieval-augmented generation) against the tenant's knowledge base articles.

#### AI architecture

Claude is accessed via the Anthropic API. All AI calls are:

- Logged per tenant for auditability and debugging
- Rate-limited per tenant to prevent abuse
- Explicitly disclosed to end users where relevant (agents see when a response is AI-drafted)
- Never used to make irreversible decisions autonomously — AI surfaces suggestions, humans confirm

The platform's AI service is a dedicated module that wraps the Anthropic SDK with platform-specific context injection, retry logic, and cost tracking.

---

## 10. Module Map

### 10.1 Core infrastructure modules (always installed, not visible to customers)

These modules are the platform. They have no customer-facing UI on their own.

| Module                        | Responsibility                                         |
| ----------------------------- | ------------------------------------------------------ |
| `@platform/entity-engine`     | Entity types, fields, instances, relations             |
| `@platform/workflow-engine`   | States, transitions, event log, SLA                    |
| `@platform/automation-engine` | Rules, triggers, actions, job execution                |
| `@platform/auth`              | Zitadel integration, JWT middleware, RBAC              |
| `@platform/notifications`     | Novu integration, template management, preferences     |
| `@platform/files`             | S3 integration, presigned URLs, metadata               |
| `@platform/audit`             | Append-only event log, compliance export               |
| `@platform/api-gateway`       | Route registration, rate limiting, API key management  |
| `@platform/connector-sdk`     | Connector interface, credential vault, webhook gateway |
| `@platform/plugin-sdk`        | Plugin lifecycle, slot registry, hook registration     |
| `@platform/ai`                | Claude API wrapper, prompt management, RAG service     |

### 10.2 Standard modules (pre-built; `core` ones installed by default, `optional` ones opt-in)

| Module                    | Key entities                        | Key workflow                                                                                                                       | Category   |
| ------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `@modules/crm`            | Contact, Company, Deal, Activity    | Lead → Qualified → Proposal → Won/Lost                                                                                             | `core`     |
| `@modules/helpdesk`       | Ticket, Comment, Article            | Open → In Progress → Pending → Resolved                                                                                            | `core`     |
| `@modules/hrms`           | Employee, Department, Leave Request | Draft → Submitted → Approved/Rejected                                                                                              | `core`     |
| `@modules/reimbursements` | Expense Claim, Receipt              | Draft → Submitted → Manager Review → Finance Review → Paid                                                                         | `core`     |
| `@modules/projects`       | Project, Task, Milestone            | Backlog → In Progress → In Review → Done                                                                                           | `core`     |
| `@modules/invoicing`      | Invoice, Quote, Payment             | Draft → Sent → Paid/Overdue/Cancelled                                                                                              | `core`     |
| `@modules/procurement`    | Purchase Order, Vendor, RFQ         | Draft → Approved → Sent → Fulfilled                                                                                                | `core`     |
| `@modules/tender`         | Tender                              | Draft → BOQ Preparation → Pending Costing Review → Costing Approved → Document Preparation → Pending Submission Review → Submitted | `optional` |

`category` (`core` \| `optional`) is the classification from ADR-005 (accepted 2026-07-23): `core`
modules auto-provision on tenant creation; `optional` modules stay opt-in via the existing install
API, same as today. `tender` is the platform's 8th module and its only `optional` one — it does
not ship with new tenants unless explicitly installed.

### 10.3 Sector packages (optional, industry-specific installs)

**Healthcare:** Patient records, appointment booking, HIPAA-compliant audit, lab results, prescription tracking, HL7/FHIR connector.

**Manufacturing:** Bill of materials, work orders, quality control checkpoints, machine maintenance schedules, batch/lot tracking, MRP planning, shift scheduling.

**Retail / E-commerce:** POS integration, multi-store inventory, loyalty programmes, returns management, product catalogue, Shopify/WooCommerce sync.

**Real estate / Property:** Property listings, tenancy lifecycle, maintenance request workflows, lease tracking, agent commission calculations, inspection reports.

**Education:** Student admissions, course management, timetabling, fee collection, gradebook, parent portal, attendance tracking.

**Logistics / Field service:** Dispatch and routing, fleet tracking, driver management, proof of delivery, job scheduling, mobile field app.

**Financial services:** KYC onboarding workflow, document collection, compliance checklist, risk scoring integration.

Each sector package is a standard plugin — it uses the same entity engine, workflow engine, and automation engine as everything else. The differentiation is purely in the domain-specific entity types, pre-built workflow configs, and sector-specific connectors.

---

## 11. Build Phases and Milestones

The phasing below is designed around one principle: **the earliest code written is the most consequential**. Multi-tenancy, auth, and the entity/workflow engine shape every subsequent line of code. These are built first and built carefully. Customer-facing features follow.

### The config-first principle

A second principle governs how modules are built on top of the engine: **modules are configuration, not code.** The three engines are written once and interpreted against database rows — entity type definitions, field definitions, workflow states and transitions, automation rules. A new business module (helpdesk, reimbursements, HRMS) ships as a seed SQL file containing INSERT statements against the engine's tables. No module-specific routes, no module-specific validators, no module-specific business logic in TypeScript.

This is not a simplification — it is the architectural bet that makes the platform competitive. Every improvement to the engine benefits every module. Every new entity type gets a functional UI immediately because the UI is driven by field config. Customers modify their workflows and automation rules at runtime without deployments.

The formal decision, consequences, escape hatches, and checklist are in [ADR-004 — Config-First Module Design](decisions/ADR-004-config-first-module-design.md). The detailed phased build plan with per-component classification is in [docs/roadmap.md](roadmap.md). The summary below covers deliverables and exit criteria per phase.

---

### Phase 1 — The unbreakable foundation (weeks 1–8)

**Deliverable:** A running, multi-tenant platform that no customer touches yet, but that every future line of code is built on. Includes infrastructure and tenancy, authentication, the entity engine, the workflow engine, and the automation engine v1.

**Exit criteria:**

- An entity type, fields, workflow, and automation rule can be created via API with **no code changes** — only config rows
- An entity instance can be created, validated against its field config, and transitioned through its workflow
- SLA timers fire; automation rules execute on trigger events
- A new module is fully representable as a seed SQL file — zero new TypeScript required
- RLS isolation verified: tenant A cannot read tenant B's data under any query pattern
- Tenant isolation test suite passes on every PR touching `packages/db/` or `apps/api/`
- Core engine test coverage ≥ 80%
- OpenBao running in docker-compose dev mode; no plaintext encryption key in environment

### Phase 2 — First customer-ready apps (weeks 9–16)

**Deliverable:** Platform services complete (notifications, files, audit log, API keys). Helpdesk, reimbursements, and CRM modules live as seed SQL configs. Generic config-driven entity UI in the customer portal and admin UI. No-code automation builder and workflow visual editor shipped. Pilot customer onboarded.

**Exit criteria:**

- Pilot customer submits tickets via portal; agents manage with full SLA enforcement
- Expense claim approval chain runs end-to-end with correct role gating
- Installing a new module requires only a seed SQL file — no code deployment
- Notification templates editable in Novu without deployment
- Penetration test (tenant isolation) passed before pilot customer receives credentials

### Phase 3 — Scale, integrations, and extensibility (weeks 17–28)

**Deliverable:** Connector marketplace with webhook gateway and connector runtime. Plugin system with Module Federation. AI layer (automation rule generation, workflow suggestion, entity classification). Drag-and-drop visual workflow builder. First sector package.

**Exit criteria:**

- A third-party connector can be installed by a tenant and trigger automations with no code change
- A plugin can add new entity types, routes, and UI slots without modifying core platform code
- An administrator can describe an automation in natural language and receive a reviewable rule config
- First sector package ships as config — no bespoke backend code

### Phase 4 — Customer-driven refinement (ongoing)

From Phase 3 onwards, the roadmap is driven by customer feedback. Feature requests triage into: config change (days), new module (1–2 weeks), engine extension (4–8 weeks with ADR). Engine changes are rare, deliberate, and benefit all tenants. Config changes ship continuously.

---

## 12. Team Structure and Ways of Working

### 12.1 Team composition

The platform requires generalist engineers who are comfortable across the full stack. Specialization by layer (frontend vs backend vs infra) is a premature optimization at this stage — it creates handoff bottlenecks on a team that needs to move fast.

**Core platform team (4–6 engineers):** Own the entity engine, workflow engine, automation engine, auth, and infrastructure. Every architectural decision goes through this team. Changes to the engine layer require peer review from at least two core team members. This team moves slowly and deliberately — an engine bug affects every customer and every module.

**Module team (2–4 engineers per module cluster):** Own one or more standard modules. Can operate largely independently once the engine layer is stable. Move fast within the constraints the engine layer provides. Add new automations, field types, workflow states, and UI features without touching core.

**Platform integration engineer (1–2):** Owns the connector SDK, webhook gateway, and first-party connectors. Reviews all community connector submissions.

**AI engineer (1):** Owns the AI service module, RAG pipeline, prompt engineering conventions, and Claude integration patterns across the platform.

### 12.2 Development conventions

**TypeScript everywhere, strictly.** `strict: true` in `tsconfig.json`. No `any`. Type assertions (`as X`) require a comment explaining why the type system cannot infer this.

**Zod for all external boundaries.** Every API input, every event payload, every config file is validated by a Zod schema. The schema is the source of truth. TypeScript types are inferred from Zod schemas, not written separately.

**No raw SQL in application code.** All queries go through Drizzle. Raw SQL via `db.execute()` is permitted only in migration files and explicitly performance-optimized hot paths, with a comment explaining why Drizzle was insufficient.

**Every PR includes tests.** No PR that adds behavior without tests passes review. Test coverage gates are enforced in CI — a PR that drops coverage below the current baseline is blocked.

**Feature flags for everything non-trivial.** No significant feature reaches production in an all-or-nothing deploy. Feature flags are managed via a simple per-tenant config table and evaluated in the tenant config middleware.

**ADRs for architectural decisions.** Every significant technical decision is recorded as an Architecture Decision Record in `/docs/decisions/`. The format: context, decision, consequences, alternatives considered. ADRs are written before implementation, not after.

### 12.3 AI-integrated development workflow

1. **Design with Claude:** Before writing a PR, the engineer discusses the feature with Claude in the context of the platform conventions and existing code. Claude identifies edge cases and suggests the implementation approach.

2. **Scaffold with Claude:** Claude generates the initial implementation — schema, API routes, business logic, tests, migration. The engineer reviews output for correctness and consistency.

3. **Review with Claude:** Before opening a PR for human review, Claude reviews the diff for: RLS violations, missing error handling, N+1 queries, type safety gaps, consistency with conventions.

4. **Human review:** Focused on: correctness of business logic, alignment with product intent, and catching anything Claude missed. Human review is faster because Claude handles mechanical correctness checks.

5. **Ship:** CI runs tests, type checks, lint, and the Claude review action. Green CI + human approval = merge.

This workflow is not about replacing engineering judgment. It is about compressing the time between intention and implementation, and catching mechanical errors before they reach human review.

---

## 13. Risks and Mitigations

### R1: Engine layer complexity underestimated

**Risk:** The entity engine and workflow engine are more complex than anticipated. The team spends months on the foundation and never reaches customer-facing features.

**Mitigation:** Phase 1 has explicit exit criteria. If those criteria are not met by week 8, the team does not proceed to Phase 2. The scope of Phase 1 is intentionally narrow — no customer-facing features, no sector packages, no connectors. The engine must be right before anything is built on top of it. Additionally: the engines described here are not novel. XState (for state machine patterns), Temporal (for durable workflow execution), and Argo (for DAG-based workflows) are all studied and referenced. We are not inventing — we are applying well-understood patterns to our specific constraints.

### R2: Multi-tenancy breach

**Risk:** A bug in RLS policy, middleware, or a raw query bypasses tenant isolation. Customer A sees Customer B's data.

**Mitigation:** RLS is enabled at the Postgres level — it is not a query-level guard that can be forgotten by a developer. The CI pipeline runs a dedicated tenant isolation test suite that attempts cross-tenant reads via every public API endpoint. Any endpoint that returns data from another tenant's records fails the suite and blocks the PR. Penetration testing is included in the Phase 2 exit criteria before pilot customer onboarding.

### R3: Plugin system enables malicious or broken plugins

**Risk:** A third-party plugin executes arbitrary code, accesses other tenants' data, or causes platform instability.

**Mitigation:** Plugin permissions are declared at install time and enforced by the platform. The plugin can only access its declared schema namespace, its declared event prefixes, and its declared UI slots. Script actions run in V8 isolates with no Node.js global access. Plugin errors are caught and isolated — they cannot crash the platform process. For the connector marketplace, all published connectors undergo a code review before listing.

### R4: AI-generated code introduces bugs or security vulnerabilities

**Risk:** Systematic use of AI code generation introduces subtle bugs that are hard to detect because they look correct and pass tests.

**Mitigation:** AI is a tool in the development workflow, not the developer. Every AI-generated output is reviewed by an engineer before merging. The test suite — including the tenant isolation tests and the engine behavior tests — is the safety net. AI-generated code that passes review + CI is held to exactly the same standard as human-written code. Additionally: the Claude review action in CI is specifically tuned to catch the failure modes most likely to appear in AI-generated code (type assertions, missing validation, etc.).

### R5: Module coupling undermines the architecture

**Risk:** As the team builds features quickly, module dependencies creep in — the CRM module directly imports from the HRMS module, the helpdesk module queries the billing database, etc. The clean architecture degrades into a monolith.

**Mitigation:** ESLint import rules enforce the dependency rule at build time. Module A cannot import from Module B. All cross-module communication goes through the event bus or the entity engine's relation API. This is enforced in CI — import violations are build errors. The ADR process ensures that any exception to this rule is documented and deliberate.

### R6: Customer workflow needs exceed the engine's capabilities

**Risk:** A customer has a workflow requirement that the engine cannot express. We cannot serve them without a code change.

**Mitigation:** The engine is designed conservatively — it is better to over-engineer the engine than to under-engineer it and add customer-specific code. The `script` action type is the escape hatch for requirements that can't be expressed declaratively. For requirements that need new engine capabilities, the ADR process ensures the change generalizes across all customers, not just the requesting one. The goal is that every customer requirement either fits in config or drives a platform-level improvement.

---

## Appendix A — Core Schema Reference

This appendix provides the complete schema for the three engines and core platform tables. All tables include `tenant_id` (RLS-enforced) and `created_at` unless noted.

```sql
-- =============================================
-- ENTITY ENGINE
-- =============================================

CREATE TABLE entity_types (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID,                    -- NULL = platform-defined
  name            TEXT NOT NULL,
  plural          TEXT NOT NULL,
  icon            TEXT,
  module_id       UUID,
  allow_custom_fields BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE entity_fields (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type_id  UUID NOT NULL REFERENCES entity_types(id),
  tenant_id       UUID,                    -- NULL = module-defined
  name            TEXT NOT NULL,
  label           TEXT NOT NULL,
  field_type      TEXT NOT NULL,
  config          JSONB DEFAULT '{}',
  is_required     BOOLEAN DEFAULT false,
  is_indexed      BOOLEAN DEFAULT false,
  is_system       BOOLEAN DEFAULT false,   -- module-defined, not deletable
  sort_order      INT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (entity_type_id, name)
);

CREATE TABLE entity_instances (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type_id  UUID NOT NULL REFERENCES entity_types(id),
  tenant_id       UUID NOT NULL,
  workflow_id     UUID REFERENCES workflows(id),
  current_state   TEXT NOT NULL DEFAULT 'initial',
  fields          JSONB NOT NULL DEFAULT '{}',
  created_by      UUID,
  assigned_to     UUID,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON entity_instances (tenant_id, entity_type_id);
CREATE INDEX ON entity_instances (tenant_id, current_state);
CREATE INDEX ON entity_instances USING GIN (fields);

ALTER TABLE entity_instances ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON entity_instances
  USING (tenant_id = current_setting('app.tenant_id')::UUID);

CREATE TABLE entity_relations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  from_instance_id UUID NOT NULL REFERENCES entity_instances(id),
  to_instance_id  UUID NOT NULL REFERENCES entity_instances(id),
  relation_type   TEXT NOT NULL,           -- field name that defines the relation
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON entity_relations (tenant_id, from_instance_id);
CREATE INDEX ON entity_relations (tenant_id, to_instance_id);

-- =============================================
-- WORKFLOW ENGINE
-- =============================================

CREATE TABLE workflows (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID,                    -- NULL = module-defined default
  entity_type_id  UUID NOT NULL REFERENCES entity_types(id),
  name            TEXT NOT NULL,
  initial_state   TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE workflow_states (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id     UUID NOT NULL REFERENCES workflows(id),
  name            TEXT NOT NULL,
  label           TEXT NOT NULL,
  color           TEXT DEFAULT '#888780',
  is_terminal     BOOLEAN DEFAULT false,
  sla_hours       INT,
  sort_order      INT DEFAULT 0
);

CREATE TABLE workflow_transitions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id     UUID NOT NULL REFERENCES workflows(id),
  from_state      TEXT NOT NULL,
  to_state        TEXT NOT NULL,
  label           TEXT,
  allowed_roles   TEXT[] DEFAULT '{}',    -- empty = any role
  conditions      JSONB DEFAULT 'null',   -- evaluated rule tree
  requires_comment BOOLEAN DEFAULT false,
  requires_fields  TEXT[] DEFAULT '{}'
);

CREATE TABLE workflow_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id     UUID NOT NULL REFERENCES entity_instances(id),
  workflow_id     UUID NOT NULL REFERENCES workflows(id),
  from_state      TEXT,
  to_state        TEXT NOT NULL,
  triggered_by    TEXT NOT NULL,
  actor_id        UUID,
  comment         TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- Intentionally NO UPDATE or DELETE permissions on workflow_events
-- Enforced at the application layer and via Postgres column-level grants

-- =============================================
-- AUTOMATION ENGINE
-- =============================================

CREATE TABLE automation_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  name            TEXT NOT NULL,
  is_enabled      BOOLEAN DEFAULT true,
  trigger_type    TEXT NOT NULL,
  trigger_config  JSONB NOT NULL,
  conditions      JSONB DEFAULT 'null',
  actions         JSONB NOT NULL,          -- ordered array of action configs
  priority        INT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE automation_executions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  rule_id         UUID NOT NULL REFERENCES automation_rules(id),
  trigger_event   JSONB NOT NULL,
  status          TEXT NOT NULL,           -- 'pending' | 'running' | 'success' | 'failed'
  result          JSONB,
  error           TEXT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- =============================================
-- EVENT BUS (OUTBOX)
-- =============================================

CREATE TABLE outbox_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  event_type      TEXT NOT NULL,
  version         INT NOT NULL DEFAULT 1,
  payload         JSONB NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT now(),
  delivered_at    TIMESTAMPTZ
);

CREATE INDEX ON outbox_events (delivered_at NULLS FIRST, created_at);
```

---

## Appendix B — Connector SDK Interface

```typescript
// @platform/connector-sdk/types.ts

export interface ConnectorDefinition<TCredentials = Record<string, unknown>> {
  meta: {
    id: string;
    name: string;
    version: string;
    description: string;
    iconUrl: string;
    docsUrl?: string;
    category:
      | "communication"
      | "finance"
      | "crm"
      | "hr"
      | "storage"
      | "ecommerce"
      | "other";
  };

  auth: OAuthConfig | ApiKeyConfig | BasicAuthConfig | CustomAuthConfig;

  triggers: TriggerDefinition[];
  actions: ActionDefinition[];

  onInstall?: (ctx: ConnectorContext<TCredentials>) => Promise<void>;
  onUninstall?: (ctx: ConnectorContext<TCredentials>) => Promise<void>;
  onCredentialRefresh?: (
    ctx: ConnectorContext<TCredentials>,
  ) => Promise<TCredentials>;
}

export interface TriggerDefinition {
  id: string;
  name: string;
  description: string;
  type: "webhook" | "polling";

  // For webhook triggers
  webhook?: {
    validateSignature: (request: Request, secret: string) => Promise<boolean>;
    transform: (rawPayload: unknown) => Promise<PlatformEvent>;
  };

  // For polling triggers
  polling?: {
    intervalMinutes: number;
    fetch: (
      ctx: ConnectorContext,
      cursor?: string,
    ) => Promise<{
      events: PlatformEvent[];
      nextCursor?: string;
    }>;
  };
}

export interface ActionDefinition {
  id: string;
  name: string;
  description: string;
  input: z.ZodSchema; // validated before execution
  output: z.ZodSchema;

  execute: (input: unknown, ctx: ConnectorContext) => Promise<unknown>;

  rateLimit?: {
    requestsPerMinute: number;
    requestsPerDay?: number;
  };

  retryConfig?: {
    maxAttempts: number;
    backoffMs: number;
    retryOn: (error: Error) => boolean;
  };
}

export interface ConnectorContext<TCredentials = Record<string, unknown>> {
  tenantId: string;
  credentials: TCredentials;
  callApi: (config: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  }) => Promise<Response>;
  log: (
    level: "info" | "warn" | "error",
    message: string,
    meta?: object,
  ) => void;
}
```

---

## Appendix C — Plugin Manifest Specification

```typescript
// @platform/plugin-sdk/manifest.ts

export interface PluginManifest {
  // Identity
  id: string; // scoped package name: '@vendor/plugin-name'
  name: string; // display name
  version: string; // semver
  platformVersion: string; // semver range: '>=1.0.0 <2.0.0'
  description?: string;
  authorUrl?: string;

  // Dependencies — other plugins that must be installed first
  requires?: string[]; // ['@platform/core-users@>=1.0.0']

  // Permissions — validated against tenant plan at install time
  permissions: PluginPermission[];

  // Backend wiring
  migrations?: string; // path to Drizzle migrations folder
  routes?: string; // path to Hono router export
  hooks?: string; // path to Hook[] export
  jobs?: string; // path to BullMQ worker definitions

  // Frontend wiring
  ui?: {
    remote: string; // Module Federation remoteEntry.js URL
    slots?: SlotRegistration[];
    pages?: PageRegistration[];
  };

  // Lifecycle
  onActivate?: string; // path to activation handler
  onDeactivate?: string; // path to deactivation handler
}

export type PluginPermission =
  | `db:${string}` // 'db:hrms.*' — schema namespace access
  | `events:${string}` // 'events:employee.*' — event prefix subscription
  | `slots:${string}` // 'slots:sidebar.nav' — UI slot registration
  | `api:${string}` // 'api:external' — make outbound HTTP calls
  | "ai:inference" // — call the platform AI service
  | "files:read"
  | "files:write";

export interface SlotRegistration {
  name: string; // 'sidebar.nav'
  component: string; // exported component name from the remote
  priority?: number; // render order within the slot (lower = earlier)
  context?: string[]; // context keys this slot needs: ['ticketId']
}

export interface PageRegistration {
  path: string; // '/hrms'
  component: string; // exported component name
  title: string; // browser tab title
  icon?: string; // Tabler icon name for nav
}
```

---

_This document represents the current architectural thinking and should be treated as a living reference. All sections are subject to revision based on implementation learnings. Significant deviations from this architecture should be recorded as ADRs in `/docs/decisions/`._

_Questions, challenges, and proposed changes to this document are actively encouraged. The goal is a platform that the engineering team owns intellectually, not one handed down from above._
