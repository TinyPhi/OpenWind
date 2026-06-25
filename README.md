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

Auth and identity (Zitadel), notifications (Novu), file storage (S3-compatible),
audit log, API gateway, background job queue (BullMQ), connector SDK, and plugin
system. Shared by every module — no module reinvents these.

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

### Connectors

First-party integrations: Slack, email (SMTP/IMAP), WhatsApp Business, Stripe,
and more. Third-party connectors installable per tenant from the connector
registry. The connector SDK makes building new integrations a single TypeScript
file.

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
│       Postgres · Redis · S3 · Search         │
└──────────────────────────────────────────────┘
```

Multi-tenant from the ground up, using Postgres Row-Level Security. Every
tenant's data is isolated at the database layer — not the application layer.
A developer who forgets a WHERE clause gets only their tenant's rows.

Full architecture documentation: [`docs/architecture-brief.md`](docs/architecture-brief.md)

---

## Tech stack

| Layer         | Technology                                                          | Why                                            |
| ------------- | ------------------------------------------------------------------- | ---------------------------------------------- |
| API framework | [Hono](https://hono.dev/)                                           | TypeScript-first, Web Standards, runs anywhere |
| Database      | [PostgreSQL 16](https://www.postgresql.org/)                        | RLS multi-tenancy, JSONB, full-text search     |
| ORM           | [Drizzle](https://orm.drizzle.team/)                                | SQL-transparent, type-safe, great migrations   |
| Queue         | [BullMQ](https://bullmq.io/)                                        | Redis-backed, reliable, good observability     |
| Auth          | [Zitadel](https://zitadel.com/)                                     | OIDC/SAML, org model maps to multi-tenancy     |
| Notifications | [Novu](https://novu.co/)                                            | Multi-channel, templates, user preferences     |
| Admin UI      | [Refine](https://refine.dev/) + [shadcn/ui](https://ui.shadcn.com/) | CRUD framework + polished components           |
| Monorepo      | [Turborepo](https://turbo.build/) + [pnpm](https://pnpm.io/)        | Cached builds, clean workspace management      |
| AI            | [Claude](https://www.anthropic.com/) (Anthropic)                    | Development tooling + platform AI features     |

---

## Getting started

### Prerequisites

- [Node.js 22+](https://nodejs.org/)
- [pnpm 9+](https://pnpm.io/installation) (`npm install -g pnpm`)
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

The bootstrap seeds a fully configured **Helpdesk** module so you can explore the platform immediately:

- **Support Ticket** entity type with 6 fields (subject, description, priority, category, customer name, email)
- **Ticket Lifecycle** workflow: New → Open → In Progress → Waiting for Customer → Resolved → Closed
- **5 sample tickets** across every workflow state (from high-priority bugs to feature requests)

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
│   ├── worker/       # BullMQ background workers
│   ├── admin-ui/     # Refine admin application
│   └── portal/       # Customer-facing portal
├── packages/
│   ├── db/           # Drizzle schema + migrations
│   ├── entity-engine/
│   ├── workflow-engine/
│   ├── automation-engine/
│   ├── connector-sdk/
│   ├── plugin-sdk/
│   ├── auth/
│   ├── notifications/
│   ├── ai/
│   └── ui/           # Shared design system
├── modules/
│   ├── crm/
│   ├── helpdesk/
│   ├── hrms/
│   ├── reimbursements/
│   ├── projects/
│   ├── invoicing/
│   └── procurement/
└── docs/
    ├── architecture-brief.md
    └── decisions/    # Architecture Decision Records
```

---

## Roadmap

OpenWind is in active early development. The build is phased:

**Phase 1 — Foundation** _(current)_
Multi-tenant Postgres, auth, entity engine, workflow engine, automation engine
v1, API layer, admin shell.

**Phase 2 — First applications**
Helpdesk, reimbursements, CRM, notification layer, connector v1 (email, Slack),
embedded reporting.

**Phase 3 — Extensibility**
Plugin system, HRMS module, connector marketplace, visual workflow builder,
AI-assisted workflow creation.

**Phase 4 — Sector depth**
Vertical sector packages (healthcare, manufacturing, education, etc.),
white-label support, advanced analytics.

See [`docs/roadmap.md`](docs/roadmap.md) for the detailed phase breakdown with
milestones and exit criteria.

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

Key technical decisions are documented as ADRs in [`docs/decisions/`](docs/decisions/):

- [ADR-001: Multi-tenancy architecture](docs/decisions/ADR-001-multitenancy.md)
- [ADR-002: Workflow engine state machine design](docs/decisions/ADR-002-workflow-engine.md)
- [ADR-003: Entity field validation strategy](docs/decisions/ADR-003-field-validation.md)

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
