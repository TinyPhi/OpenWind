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

- **Per-module domain TypeScript.** Modules are seed SQL + minimal stub index files. Any business logic in TypeScript inside `modules/` is wrong — that belongs in an engine feature.
- **Bespoke integrations.** Connectors use the connector SDK — no custom HTTP clients scattered across routes.
- **Relying on RLS alone without explicit tenant filters.** RLS (`app.tenant_id` GUC) is the second line of defence; explicit `WHERE tenant_id = ?` in engine queries is the first. Both must be present. `withTenantContext` sets the GUC but does not change the DB role — RLS enforcement depends on the connection role. Do not remove explicit tenant filters under the assumption that RLS alone is sufficient.
- **Parallel approval.** Explicitly deferred to Phase 3. Sequential approval only for pilot.
- **A chatbot.** AI features (classification, RAG replies, automation generation) are assistants — humans review before any irreversible action.

---

## Current milestone — Phase 3 (planning required before 3A starts)

### Phase 2 — ✅ Complete (2026-06-18)

All four tracks merged. Full status in [roadmap-tracker.md](docs/tracker/roadmap-tracker.md).

- 2A — Platform services (files, notifications, audit, view_configs, OpenAPI): ✅ Done
- 2B — Module system + 7 module seeds: ✅ Done
- 2C — Customer portal + agent UI: ✅ Done
- 2D — No-code builders + export + workflow canvas: ✅ Done

### Phase 3 tracks (not started — human planning sign-off required)

- 3A — Integration layer: connector runtime, webhook gateway, marketplace
- 3B — Plugin system: Module Federation, slot registry, lifecycle service
- 3C — AI layer: automation gen, workflow suggestion, RAG, usage metering
- 3D — Observability + compliance: OTel, Prometheus, GDPR, audit

---

## Core principles

1. **Config over code.** Any change expressible as seed SQL must not require TypeScript. Every time we catch ourselves writing module-specific TypeScript, we ask: is this a missing engine feature?

2. **Isolation is not optional.** Explicit `WHERE tenant_id = ?` filters in every engine query (primary guard) plus RLS via `app.tenant_id` GUC (second line of defence), tenant-scoped rate limits, presigned-only file access, OpenBao for secrets. These are not polish — they are the product. A cross-tenant leak is a company-ending event.

3. **Tests travel with the code.** Implementation without tests does not ship. Isolation tests travel with every new table or route. The test suite is the living specification.
