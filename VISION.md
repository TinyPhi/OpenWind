# Vision — OpenWind Platform

**Status:** Living document. Update when a phase gate is crossed.  
**Scope:** Agent-facing quick reference — current milestone, principles, scope boundaries.  
**Full roadmap:** [docs/platform-vision.md](docs/platform-vision.md) has the architecture and execution detail. These two documents are intentionally separate: this one is short and agent-loadable; the other is the full reference.

---

## What we are building

A modular, workflow-native business platform where every product — helpdesk, CRM, HRMS, reimbursements — is a configuration of three shared engines (Entity, Workflow, Automation). Customers never wait for a developer to add a field, change a workflow state, or wire up a notification. Businesses configure; the engine interprets.

The platform is multi-tenant by default, with row-level security enforced at the Postgres layer so no application query can leak cross-tenant data. Every state change is an event; every event can trigger an automation. The data model is inspectable, exportable, and auditable by design.

We are NOT building a generic CRUD framework, a no-code toy, or a mono-product SaaS. We are building the foundation that makes it trivially easy to ship any domain-specific business application as configuration.

---

## What we are NOT building

- **Per-module TypeScript.** Modules are seed SQL only. If an agent or engineer writes TypeScript inside `modules/`, something is wrong.
- **Bespoke integrations.** Connectors use the connector SDK — no custom HTTP clients scattered across routes.
- **Hand-rolled multi-tenancy.** All isolation is via RLS. Never add `WHERE tenant_id = ?` clauses to compensate for a missing policy.
- **Parallel approval in Phase 2.** Explicitly deferred. Sequential approval only for pilot.
- **A chatbot.** AI features (classification, RAG replies, automation generation) are assistants — humans review before any irreversible action.

---

## Current milestone — Phase 2 (2026-Q2)

### Track 2A — Platform Services `95% done`

Files, notifications, audit, view_configs, OpenAPI spec. Pending: CI green on the full Docker test suite.

**Acceptance criteria:**

- [ ] `pnpm test` passes in Docker (all packages)
- [ ] `pnpm test:isolation` passes (RLS for files, audit_log, view_configs, user_prefs)
- [ ] `pnpm typecheck && pnpm lint` clean
- [ ] 2A PR merged into main

### Track 2B — Module system + standard module configs `0% done`

Module registry, seed runner, 7 module seed files (helpdesk, CRM, HRMS, reimbursements, projects, invoicing, procurement). This is the config-first test in action: zero TypeScript changes outside `packages/*` and `apps/*`.

**Acceptance criteria:**

- [ ] Module registry table + seed runner in `packages/db`
- [ ] All 7 module seed files runnable via `pnpm db:seed --module=<name>`
- [ ] Each module: entity types, field defs, workflow states + transitions, initial automation rules
- [ ] Helpdesk SLA timer fires on ticket created; escalation automation triggers
- [ ] RLS isolation tests for module-seeded entity types pass
- [ ] Config-first test passes: zero new TypeScript files in `modules/`

---

## Core principles

1. **Config over code.** Any change expressible as seed SQL must not require TypeScript. Every time we catch ourselves writing module-specific TypeScript, we ask: is this a missing engine feature?

2. **Isolation is not optional.** RLS, tenant-scoped rate limits, presigned-only file access, OpenBao for secrets. These are not polish — they are the product. A cross-tenant leak is a company-ending event.

3. **Tests travel with the code.** Implementation without tests does not ship. Isolation tests travel with every new table or route. The test suite is the living specification.
