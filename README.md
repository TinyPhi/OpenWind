<div align="center">

<br/>

```
  ___                 _    _ _         _
 / _ \ _ __  ___ _ _| |  | | |_ _ __ __| |
| (_) | '_ \/ -_) ' \ |/\| | | ' \/ _` |
 \___/| .__/\___|_||_\_/  \_|_|_||_\__,_|
      |_|
```

**A modular, workflow-native business platform.**  
Built for teams that outgrew their SaaS stack but aren't ready to build from scratch.

<br/>

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Built with TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22+-green?logo=node.js&logoColor=white)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

---

## What is OpenWind?

OpenWind is an open-source, self-hostable business operating platform. It
replaces the patchwork of disconnected SaaS tools that most growing businesses
accumulate — a helpdesk here, an expense system there, a CRM somewhere else —
with a single coherent platform where every module shares the same data layer,
auth, workflow engine, and integration infrastructure.

The core insight behind OpenWind is simple:

> A support ticket, an expense claim, a sales deal, and a purchase order are
> all the same thing — a stateful object moving through a workflow. Once you
> build that engine well, every business process is just configuration on
> top of it.

OpenWind is built for software engineering teams that want to own their
operational stack — either to deploy it internally, extend it for specific
customers, or build sector-specific products on top of it.

---

## The three engines

Everything in OpenWind is powered by three shared engines. Modules, sector
packages, and custom workflows are all configurations of these engines —
not new codebases.

### Entity Engine

Define what your business works with. Contacts, tickets, expenses, assets,
employees — any entity type, with typed fields, relations, and per-tenant
custom fields. No migrations needed when a customer adds a field.

### Workflow Engine

Define how things move. A finite state machine for any entity: states,
transitions, role-based guards, conditional branching, SLA timers with
automatic escalation, and an immutable event log for every transition ever made.

### Automation Engine

Define what happens when things move. An event → condition → action pipeline
that fires on any state change, field update, or external event. Powers
notification routing, assignment rules, cross-system integrations, and
SLA enforcement — all from configuration, no code required.

---

## What's included

### Core platform

Auth and identity (Zitadel), notifications (Novu), tenant-scoped local-disk file
storage with async ClamAV malware scanning, an append-only audit log, secrets
management (OpenBao), API gateway, background job queue (BullMQ), a connector
runtime with an inbound webhook gateway and polling-connector framework, and a
plugin system (Module Federation). Shared by every module — no module reinvents
these. Observability (OpenTelemetry, Prometheus, Sentry) and GDPR-relevant
controls (tenant/per-user erasure, configurable retention, IP allowlisting) are
built in, not bolted on.

### Standard modules

Pre-built applications that install on top of the engines:

| Module             | What it does                                               |
| ------------------ | ---------------------------------------------------------- |
| **CRM**            | Contacts, companies, deals, pipeline, activities           |
| **Helpdesk**       | Tickets, SLA, assignments, knowledge base, customer portal |
| **HRMS**           | Employees, org chart, leaves, attendance, onboarding       |
| **Reimbursements** | Expense claims, multi-level approvals, receipt management  |
| **Projects**       | Tasks, milestones, sprints, kanban, time tracking          |
| **Invoicing**      | Invoices, quotes, payment links, recurring billing         |
| **Procurement**    | Purchase orders, vendor management, approval chains        |
| **Tender**         | Tender/bid tracking, costing sub-tasks, approval workflow  |

### Ticket & record features

Cross-cutting capabilities available to any entity-engine-backed module (helpdesk, tender, and others):

- **Child tickets** — break a ticket into sub-tasks with their own workflow state, assignee, and due date. Depth and per-parent count are configurable per workflow (`max_child_depth` / `max_children_per_parent`); archiving a parent archives its children too.
- **Access requests** — a non-privileged user can request read/comment/write access to a record they don't own; an admin, agent, or the record's owner can approve or reject the request, with a full history event either way.
- **Attachments** — file uploads on tickets and comments, backed by tenant-scoped local-disk storage with async ClamAV malware scanning and per-tenant storage quotas.
- **My Tickets** — a user-scoped view combining a customer's own tickets, tickets they're mentioned/granted access on, and their children — with per-workflow counts.
- **Multiple workflow admins** — a workflow can have more than one designated admin (`assigned_to` is a list, not a single user), each with settings access.

### Connectors

A connector runtime (inbound webhook gateway with HMAC verification, plus a
polling-connector framework for systems with no webhook support) and a
tenant-scoped connector credential store, both built and merged. Slack
notifications ship today; email (SMTP/IMAP), WhatsApp Business, and a
connector marketplace UI are in progress — see
[`docs/tracker/roadmap-tracker.md`](docs/tracker/roadmap-tracker.md) (track 3A)
for current status before assuming a specific integration is ready to use.

---

## Architecture

```
┌──────────────────────────────────────────────┐
│            Customer applications             │
│   CRM · Helpdesk · HRMS · Reimbursements    │
├──────────────────────────────────────────────┤
│                Engine layer                  │
│  Entity Engine · Workflow Engine · Automation │
├──────────────────────────────────────────────┤
│             Integration layer                │
│  Event bus · Connector SDK · Webhook gateway │
├──────────────────────────────────────────────┤
│             Platform services                │
│  Auth · Notifications · Files · Audit · API  │
├──────────────────────────────────────────────┤
│               Infrastructure                 │
│  Postgres · PgBouncer · Redis · OpenBao ·    │
│      local disk (files) · ClamAV             │
└──────────────────────────────────────────────┘
```

Multi-tenant from the ground up, using Postgres Row-Level Security. Every
tenant's data is isolated at the database layer — not the application layer.
A developer who forgets a WHERE clause gets only their tenant's rows.

Full architecture documentation: [`docs/architecture-brief.md`](docs/architecture-brief.md)

---

## Tech stack

| Layer         | Technology                                                          | Why                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API framework | [Hono](https://hono.dev/)                                           | TypeScript-first, Web Standards, runs anywhere                                                                                                         |
| Database      | [PostgreSQL 16](https://www.postgresql.org/)                        | RLS multi-tenancy, JSONB, full-text search                                                                                                             |
| ORM           | [Drizzle](https://orm.drizzle.team/)                                | SQL-transparent, type-safe, great migrations                                                                                                           |
| Queue         | [BullMQ](https://bullmq.io/)                                        | Redis-backed, reliable, good observability                                                                                                             |
| Auth          | [Zitadel](https://zitadel.com/)                                     | OIDC/SAML, org model maps to multi-tenancy                                                                                                             |
| Notifications | [Novu](https://novu.co/)                                            | Multi-channel, templates, user preferences                                                                                                             |
| Admin UI      | [Refine](https://refine.dev/) + [shadcn/ui](https://ui.shadcn.com/) | CRUD framework + polished components                                                                                                                   |
| Secrets       | [OpenBao](https://openbao.org/)                                     | Self-hosted secrets management (Vault fork)                                                                                                            |
| Monorepo      | [Turborepo](https://turbo.build/) + [pnpm](https://pnpm.io/)        | Cached builds, clean workspace management                                                                                                              |
| AI            | [Claude](https://www.anthropic.com/) (Anthropic)                    | Primary development tooling today; platform AI features (automation-rule generation, digests) are early/in-progress, not yet shipped — see the roadmap |

---

## Getting started

### Prerequisites

- [Node.js 22+](https://nodejs.org/)
- [pnpm 11+](https://pnpm.io/installation) (`npm install -g pnpm`)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (running)

### Quick start — one command

```bash
git clone https://github.com/TinyPhi/OpenWind.git
cd OpenWind
pnpm install --frozen-lockfile
pnpm bootstrap
```

The bootstrap script handles everything automatically:

| Step | What it does                                              |
| ---- | --------------------------------------------------------- |
| 1    | Checks Node.js, pnpm, and Docker versions                 |
| 2    | Creates `.env.local` from `.env.example`                  |
| 3    | Starts all Docker services (`docker compose up -d`)       |
| 4    | Waits for Postgres and Zitadel to be healthy              |
| 5    | Installs all workspace dependencies                       |
| 6    | Runs database migrations and seeds base data              |
| 7    | Configures Zitadel (OIDC app, roles, auth credentials)    |
| 8    | Creates three demo users with different permission levels |
| 9    | Seeds a complete Helpdesk demo with 5 sample tickets      |
| 10   | Prints all URLs and credentials                           |

> **Fully automated** — Bootstrap reads the Zitadel setup token automatically from the container. No browser step, no copy-pasting. Every run is headless.

After bootstrap finishes, everything is already running in Docker. Open `http://localhost:3001` and log in.

To rebuild and restart all containers after code changes:

```bash
docker compose up -d --build
```

### What you get

| URL                          | Service                                                  |
| ---------------------------- | -------------------------------------------------------- |
| `http://localhost:3001`      | App — admin, agent, and customer views (RBAC-controlled) |
| `http://localhost:3000`      | API                                                      |
| `http://localhost:3000/docs` | API docs (Scalar)                                        |
| `http://localhost:8080`      | Zitadel console                                          |

All user types log in at the same URL (`http://localhost:3001`). The app reads the role from the JWT and shows the appropriate view automatically.

### Demo credentials

| Username  | Password        | Role  | View shown after login |
| --------- | --------------- | ----- | ---------------------- |
| `owAdmin` | `OpenWind1234!` | Admin | Full admin panel       |
| `owAgent` | `OpenWind1234!` | Agent | Agent / support view   |
| `owUser`  | `OpenWind1234!` | User  | Customer / portal view |

> You can also log in with the full email (`owAdmin@openwind.local`, etc.) — both work.

| Username               | Password     | Role   | Access               |
| ---------------------- | ------------ | ------ | -------------------- |
| `admin@platform.local` | `Admin1234!` | System | Zitadel console only |

### Seeded demo data

The bootstrap seeds the **module registry** (Helpdesk, CRM, HRMS, Reimbursements, Projects,
Invoicing, Procurement, Tender) so every template shows up on the Templates page — it does not
create any tenant-owned entity types, workflows, or records. Log in and install a module (e.g.
Helpdesk) from the Templates page to seed its `ticket` entity type, 4-state workflow
(open → in_progress → pending → resolved), and automation rule into your own tenant.

### Resetting everything

```bash
docker compose down -v   # removes all container data (volumes wiped)
rm .env.local            # removes your local env + generated credentials
pnpm bootstrap           # full setup from scratch (fully automated, no manual steps)
```

> **Important:** Always use `docker compose down -v` (not just `down`) before re-running bootstrap from scratch. Without `-v`, Docker preserves the Postgres volume and the old Zitadel data will mix with the new setup.

Full setup guide (local + production): [`SETUP.md`](SETUP.md)

---

## Project structure

```
OpenWind/
├── apps/
│   ├── api/          # Hono API server
│   ├── worker/       # BullMQ background workers (outbox, automation,
│   │                 #   SLA, notifications, file scanning, retention)
│   └── admin-ui/     # Refine + shadcn/ui — single app serving admin,
│                     #   agent, and customer views (RBAC-controlled)
│                     #   (apps/portal was removed in PR #211; the
│                     #   directory is a pnpm workspace stub only)
├── packages/
│   ├── db/           # Drizzle schema + migrations
│   ├── entity-engine/
│   ├── workflow-engine/
│   ├── automation-engine/
│   ├── connector-sdk/
│   ├── plugin-sdk/
│   ├── auth/         # Zitadel JWT + RBAC
│   ├── notifications/# Novu wrapper
│   ├── files/        # Local-disk file storage + ClamAV scanning
│   ├── audit/        # Append-only audit log
│   ├── secrets/      # OpenBao client
│   ├── redis/        # Shared client + rate limiting
│   ├── config/       # Zod-validated env vars
│   ├── logger/       # Structured pino logger
│   ├── telemetry/    # OTel/Prometheus/Sentry, usage metering
│   ├── teams/        # Teams/services/on-call-schedule primitives
│   ├── scheduler/    # Temporal scheduler primitives
│   ├── ai/           # Anthropic SDK wrapper (early — see roadmap)
│   └── ui/           # Shared design system
├── modules/          # Seed SQL + a one-line stub index.ts per module —
│   ├── crm/          #   no domain-logic TypeScript, ever (ADR-004)
│   ├── helpdesk/
│   ├── hrms/
│   ├── reimbursements/
│   ├── projects/
│   ├── invoicing/
│   ├── procurement/
│   └── tender/
└── docs/
    ├── architecture-brief.md
    ├── decisions/     # Architecture Decision Records (ADR-001–017)
    └── tracker/roadmap-tracker.md  # live phase/track status
```

---

## Roadmap

**Phase 1 — Foundation** ✅ done (2026-05-21)
Multi-tenant Postgres/RLS, auth, entity engine, workflow engine, automation
engine, API layer, admin shell.

**Phase 2 — First customer-ready apps** ✅ done (2026-06-18)
Helpdesk, reimbursements, CRM, HRMS, projects, invoicing, procurement, tender,
admin UI + customer portal views, notification layer, no-code builders.

**Phase 3 — Scale & extensibility** 🟡 in progress
Eight parallel tracks — connector runtime & marketplace (3A), plugin system
(3B, ✅ done), AI layer (3C, not started), observability & GDPR compliance
(3D, ✅ done), on-call routing & severity notifications (3E, in progress),
temporal scheduler (3F, in progress), MIS/reporting dashboards (3G, spec in
review), cross-functional workflow visibility (3H, in progress).

**Phase 4 — Sector depth** _(not started)_
Vertical sector packages, white-label support, advanced analytics.

This project moves fast — treat the summary above as a snapshot, not a
commitment. See [`docs/tracker/roadmap-tracker.md`](docs/tracker/roadmap-tracker.md)
for the live, per-track breakdown with owners and exit criteria, and
`CLAUDE.md`'s "Current focus" section for the phase this repo is actively
working on right now.

---

## Contributing

OpenWind is built in the open and contributions are welcome. Before opening a
PR, please read:

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to contribute
- [`CLAUDE.md`](CLAUDE.md) — engineering conventions (also used by our AI
  development tooling)
- [`docs/decisions/`](docs/decisions/) — architecture decision records that
  explain the why behind key technical choices

**Good first issues** are tagged
[`good first issue`](https://github.com/TinyPhi/OpenWind/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
in the issue tracker.

For significant contributions — new modules, changes to the engine layer,
new connector types — please open a discussion issue first to align on approach
before writing code.

---

## Architecture decision records

Key technical decisions are documented as ADRs in [`docs/decisions/`](docs/decisions/) — 17 as of
this writing, humans-only to write or modify:

- [ADR-001: Multi-tenancy architecture](docs/decisions/ADR-001-multitenancy.md)
- [ADR-002: Workflow engine state machine design](docs/decisions/ADR-002-workflow-engine.md)
- [ADR-003: Entity field validation strategy](docs/decisions/ADR-003-field-validation.md)
- [ADR-004: Config-first module design](docs/decisions/ADR-004-config-first-module-design.md)
- [ADR-005: Module optionality & tender](docs/decisions/ADR-005-module-optionality-and-tender.md)
- [ADR-006: Per-workflow ownership/admin model](docs/decisions/ADR-006-per-workflow-ownership-admin-model.md)
- [ADR-007: RLS for workflow config tables](docs/decisions/ADR-007-rls-workflow-config-tables.md)
- [ADR-008: API key credential lifecycle hardening](docs/decisions/ADR-008-api-key-credential-lifecycle-hardening.md)
- [ADR-009: Connector runtime & webhook gateway architecture](docs/decisions/ADR-009-connector-runtime-webhook-gateway-architecture.md)
- [ADR-010: Inbound partner API integration](docs/decisions/ADR-010-inbound-partner-api-integration.md)
- [ADR-011: Plugin system](docs/decisions/ADR-011-plugin-system.md)
- [ADR-012: Third-party API ticket access](docs/decisions/ADR-012-third-party-api-ticket-access.md)
- [ADR-013: Unified rate-limiting strategy](docs/decisions/ADR-013-unified-rate-limiting-strategy.md)
- [ADR-014: Notification SLA retry & escalation](docs/decisions/ADR-014-notification-sla-retry-escalation.md)
- [ADR-015: Observability & compliance](docs/decisions/ADR-015-observability-compliance.md)
- [ADR-016: On-call routing](docs/decisions/ADR-016-oncall-routing.md)
- [ADR-017: Temporal scheduler](docs/decisions/ADR-017-temporal-scheduler.md)

This list drifts — if it's missing a recent ADR, check [`docs/decisions/`](docs/decisions/)
directly rather than trusting the count above.

---

## License

OpenWind is released under the [GNU Affero General Public License v3.0](LICENSE).

This means you can use, modify, and self-host OpenWind freely. If you modify
OpenWind and offer it as a service to others, you must release your modifications
under the same license.

For commercial licensing (embedding OpenWind in a proprietary product without
AGPL obligations), contact [abmish@outlook.in](mailto:abmish@outlook.in).

---

## About TinyPhi

[TinyPhi](https://github.com/TinyPhi) builds open-source infrastructure for
teams that need enterprise-grade software without enterprise-grade overhead.
OpenWind is our first major open-source project.

---

<div align="center">
<sub>Built with TypeScript, Postgres, and a lot of careful thought about workflows.</sub>
</div>
