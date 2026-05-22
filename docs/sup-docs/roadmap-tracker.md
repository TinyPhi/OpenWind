# Platform Roadmap Tracker

**Last updated:** 2026-05-22
**Team model:** AI-first (Claude Code as primary engineering partner)
**Tracking:** Update `% done` and `Status` each session. Log milestones in [week-log.md](week-log.md).

---

## Summary scorecard

| Phase                           | Tracks              | Done           | % Complete | Gate                        |
| ------------------------------- | ------------------- | -------------- | ---------- | --------------------------- |
| Phase 1 — Foundation            | 5 tracks + security | 5/5 + security | **100%**   | All phase:1 issues closed   |
| Phase 2 — First Customer Apps   | 4 tracks            | 0/4            | **0%**     | Pilot customer onboarding   |
| Phase 3 — Scale & Extensibility | 5 tracks            | 0/5            | **0%**     | Public launch / marketplace |

---

## Phase 1 — The Unbreakable Foundation

**Goal:** Multi-tenant platform, no customer-facing features. Engine layer complete and battle-tested.
**Completed:** 2026-05-21

| ID    | Feature / Track                         | GH Issue(s)                                                                                                                                | Owner       | Status  | %   | Notes                                                                                                      |
| ----- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ------- | --- | ---------------------------------------------------------------------------------------------------------- |
| 1A    | Infrastructure, Tenancy & Secrets       | [#7](../../issues/7)                                                                                                                       | abmish      | ✅ Done | 100 | OpenBao, RLS, PgBouncer, tenant lifecycle, correlation ID, error handler, rate limiting                    |
| 1B    | Auth — Zitadel JWT, RBAC & API Keys     | [#8](../../issues/8)                                                                                                                       | abmish      | ✅ Done | 100 | JWT validation, RBAC, API keys, token introspection, field-level permissions                               |
| 1C    | Entity Engine                           | [#9](../../issues/9)                                                                                                                       | PrabhuVijit | ✅ Done | 100 | CRUD, bulk ops, full-text search, cursor pagination, soft deletes, relations, isolation tests              |
| 1D    | Workflow Engine                         | [#10](../../issues/10)                                                                                                                     | PrabhuVijit | ✅ Done | 100 | executeTransition, pessimistic lock, SLA timers, idempotency, event log, isolation tests                   |
| 1E    | Automation Engine + Event Bus           | [#11](../../issues/11)                                                                                                                     | PrabhuVijit | ✅ Done | 100 | Outbox poller, rule executor, circuit breaker, DLQ, recursion guard, isolation tests                       |
| 1-SEC | Security hardening — auth & entity gaps | [#1](../../issues/1), [#8](../../issues/8), [#22](../../issues/22), [#67](../../issues/67), [#68](../../issues/68), [#69](../../issues/69) | abmish      | ✅ Done | 100 | API key hashing, ReDoS guards, cross-tenant user_ref validation, OpenBao script, tenant-scoped rate limits |

### Phase 1 carry-overs — triaged 2026-05-22

| Issue                  | Title                                           | Decision                                                                                          | Gate            |
| ---------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------- |
| [#3](../../issues/3)   | Workflow reliability gaps (tracker)             | ✅ **CLOSED** — items 1–3 done (#59–61), item 4 tracked in #62                                    | —               |
| [#64](../../issues/64) | Transition rollback / undo policy               | ✅ **CLOSED** — Option A: irreversible by design, ADR-002 WE-02 resolved, engine.ts comment added | —               |
| [#2](../../issues/2)   | SSRF + PII leakage gaps                         | 🔴 **PILOT BLOCKER** — must close before any customer data lands                                  | Before 2A ships |
| [#5](../../issues/5)   | Tenant lifecycle + audit log + outbox retention | 🟡 **SPLIT into 2A** — items 1+2 are 2A work; item 3 (outbox retention) deferred to load testing  | 2A              |
| [#4](../../issues/4)   | Schema cache stampede + redis.keys()            | 🟡 **DEFER** — only bites at scale; fix before second pilot customer / load testing               | Pre-GA          |
| [#62](../../issues/62) | Workflow version GC + stuck instance recovery   | 🟡 **DEFER** — gated on 2D (workflow editor); pilot uses fixed seed SQL                           | Before 2D       |
| [#65](../../issues/65) | Parallel approval edge cases                    | 🟡 **DEFER (phase:3)** — parallel approval off-limits for pilot; sequential only                  | Post-pilot      |

---

## Phase 2 — First Customer-Ready Apps

**Goal:** Helpdesk, reimbursements, CRM live for pilot customers. Modules are pure config (seed SQL + UI views only).
**Started:** —
**Target:** Week 9–16 from project start (~2026-06-02 to 2026-06-27)
**Exit test:** Penetration test (tenant isolation) passes before any pilot is onboarded.

| ID  | Feature / Track                            | GH Issue(s)            | Owner | Status         | %   | Notes                                                                                                            |
| --- | ------------------------------------------ | ---------------------- | ----- | -------------- | --- | ---------------------------------------------------------------------------------------------------------------- |
| 2A  | Platform Services — Novu, files, audit log | [#12](../../issues/12) | —     | 🔴 Not started | 0   | Notifications, file upload/download, audit log table + read API, view_configs, OpenAPI spec                      |
| 2B  | Module system + standard module configs    | [#13](../../issues/13) | —     | 🔴 Not started | 0   | Module registry, seed runner, 7 module seed files (helpdesk, CRM, reimb, projects, HRMS, invoicing, procurement) |
| 2C  | Customer portal + agent UI                 | [#14](../../issues/14) | —     | 🔴 Not started | 0   | Config-driven generic views, Refine, entity list/detail/form from view_configs                                   |
| 2D  | No-code builders + reporting               | [#15](../../issues/15) | —     | 🔴 Not started | 0   | Automation builder UI, workflow editor UI, Metabase embed                                                        |

### Phase 2 sub-items (2B module seeds)

| Module                  | Entity types                        | Workflow                                        | Seed SQL | Status         |
| ----------------------- | ----------------------------------- | ----------------------------------------------- | -------- | -------------- |
| @modules/helpdesk       | Ticket, Comment, Article            | Open → In Progress → Pending → Resolved + SLA   | —        | 🔴 Not started |
| @modules/reimbursements | Expense Claim, Receipt              | Draft → Submitted → Mgr Review → Finance → Paid | —        | 🔴 Not started |
| @modules/crm            | Contact, Company, Deal, Activity    | Lead → Qualified → Proposal → Won/Lost          | —        | 🔴 Not started |
| @modules/projects       | Project, Task, Milestone            | Backlog → In Progress → In Review → Done        | —        | 🔴 Not started |
| @modules/hrms           | Employee, Department, Leave Request | Draft → Submitted → Approved/Rejected           | —        | 🔴 Not started |
| @modules/invoicing      | Invoice, Quote, Payment             | Draft → Sent → Paid/Overdue/Cancelled           | —        | 🔴 Not started |
| @modules/procurement    | Purchase Order, Vendor, RFQ         | Draft → Approved → Sent → Fulfilled             | —        | 🔴 Not started |

---

## Phase 3 — Scale & Extensibility

**Goal:** Platform extensible by third parties. Connector marketplace, plugin system, AI layer, first sector package.
**Exit test:** External developer ships a connector or plugin using public SDK only.

| ID    | Feature / Track                                                     | GH Issue(s)            | Owner | Status         | %   | Notes |
| ----- | ------------------------------------------------------------------- | ---------------------- | ----- | -------------- | --- | ----- |
| 3A    | Integration layer — connector runtime, webhook gateway, marketplace | [#16](../../issues/16) | —     | 🔴 Not started | 0   |       |
| 3B    | Plugin system — Module Federation, slot registry, lifecycle service | [#17](../../issues/17) | —     | 🔴 Not started | 0   |       |
| 3C    | AI layer — automation gen, workflow suggestion, RAG, usage metering | [#18](../../issues/18) | —     | 🔴 Not started | 0   |       |
| 3D    | Observability + compliance — OTel, Prometheus, GDPR, audit          | [#19](../../issues/19) | —     | 🔴 Not started | 0   |       |
| 3-OPS | Deferred ops/compliance/infra concerns                              | [#6](../../issues/6)   | —     | 🔴 Not started | 0   |       |

---

## How to update this doc

1. When a GH issue closes → update `Status` to ✅ Done, set `%` to 100, log date in [week-log.md](week-log.md)
2. When a track is partially done → update `%` to estimated progress and add a note
3. When a new sub-item is identified → add a row, create a GH issue, link it
4. Run a session-start check: `gh issue list --state open --label phase:2` to see what's active
