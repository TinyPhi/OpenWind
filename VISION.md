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
- **Parallel approval.** Off-limits — no track owns it (#65). Sequential approval only.
- **A chatbot.** AI features (classification, RAG replies, automation generation) are assistants — humans review before any irreversible action.

---

## Current milestone — Phase 3 (Scale & Extensibility)

Phase 1 ✅ 2026-05-21 · Phase 2 ✅ 2026-06-18 (2A platform services, 2B module system + seeds, 2C
agent/customer UI, 2D no-code builders). Per-track status, PRs and % live only in
[roadmap-tracker.md](docs/tracker/roadmap-tracker.md) — this list changes only when a track starts or finishes.

- **Done:** 3B plugin system (2 gaps tracked in #644) · 3D observability + compliance
- **Merged with known gaps:** 3E on-call routing (#570, #571) · 3F temporal scheduler (#580)
- **In progress:** 3A integration layer (runtime + partner API shipped; connectors + marketplace
  not started) · 3G Superset reporting (both stages merged; isolation ADR pending) · 3H
  cross-functional workflow visibility (Phase 1)
- **Not started (human scope call):** 3C AI layer · 3-OPS deferred ops concerns

---

## Core principles

1. **Config over code.** Any change expressible as seed SQL must not require TypeScript. Every time we catch ourselves writing module-specific TypeScript, we ask: is this a missing engine feature?

2. **Isolation is not optional.** Explicit `WHERE tenant_id = ?` filters in every engine query (primary guard) plus RLS via `app.tenant_id` GUC (second line of defence), tenant-scoped rate limits, signed-URL-only file access, OpenBao for secrets. These are not polish — they are the product. A cross-tenant leak is a company-ending event.

3. **Tests travel with the code.** Implementation without tests does not ship. Isolation tests travel with every new table or route. The test suite is the living specification.
