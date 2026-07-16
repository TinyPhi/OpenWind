# Platform Roadmap Tracker

**Last updated:** 2026-07-16 (PR #144 — child tickets, tender module (8th standard module), access-request flow, attachments, "My Tickets" view, multi-admin workflows, plus a pre-PR security hardening pass — see "Out-of-band feature work" under Phase 2 below)
**Team model:** AI-first (Claude Code as primary engineering partner)
**Tracking:** Update `% done` and `Status` each session. Log milestones in [week-log.md](week-log.md).

---

## Summary scorecard

| Phase                           | Tracks              | Done            | % Complete | Gate                                             |
| ------------------------------- | ------------------- | --------------- | ---------- | ------------------------------------------------ |
| Phase 1 — Foundation            | 5 tracks + security | 5/5 + security  | **100%**   | All phase:1 issues closed                        |
| Phase 2 — First Customer Apps   | 4 tracks            | 4/4 + hardening | **100%**   | Pre-Phase 3 hardening items #120–#129 all closed |
| Phase 3 — Scale & Extensibility | 5 tracks            | 0/5             | **0%**     | Public launch / marketplace                      |

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

| Issue                  | Title                                           | Decision                                                                                                      | Gate       |
| ---------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------- |
| [#3](../../issues/3)   | Workflow reliability gaps (tracker)             | ✅ **CLOSED** — items 1–3 done (#59–61), item 4 tracked in #62                                                | —          |
| [#64](../../issues/64) | Transition rollback / undo policy               | ✅ **CLOSED** — Option A: irreversible by design, ADR-002 WE-02 resolved, engine.ts comment added             | —          |
| [#2](../../issues/2)   | SSRF + PII leakage gaps                         | ✅ **CLOSED** — PR #85 merged; SSRF block + PII redaction + cross-tenant ref guard                            | —          |
| [#5](../../issues/5)   | Tenant lifecycle + audit log + outbox retention | ✅ **CLOSED** — PR #86 merged; lifecycle service, purge worker, audit entries, abmish review fixes all landed | 2A         |
| [#4](../../issues/4)   | Schema cache stampede + redis.keys()            | 🟡 **DEFER** — only bites at scale; fix before second pilot customer / load testing                           | Pre-GA     |
| [#62](../../issues/62) | Workflow version GC + stuck instance recovery   | 🟡 **DEFER** — gated on 2D (workflow editor); pilot uses fixed seed SQL                                       | Before 2D  |
| [#65](../../issues/65) | Parallel approval edge cases                    | 🟡 **DEFER (phase:3)** — parallel approval off-limits for pilot; sequential only                              | Post-pilot |

---

## Phase 2 — First Customer-Ready Apps

**Goal:** Helpdesk, reimbursements, CRM live for pilot customers. Modules are pure config (seed SQL + UI views only).
**Started:** —
**Target:** Week 9–16 from project start (~2026-06-02 to 2026-06-27)
**Exit test:** Penetration test (tenant isolation) passes before any pilot is onboarded.

| ID    | Feature / Track                            | GH Issue(s)                                   | Owner       | Status  | %   | Notes                                                                                                                                                                                                                                                    |
| ----- | ------------------------------------------ | --------------------------------------------- | ----------- | ------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2A    | Platform Services — Novu, files, audit log | [#12](../../issues/12)                        | PrabhuVijit | ✅ Done | 100 | All phases complete. Tenant lifecycle (PR #86) merged and CI green. Docker build fixed (local driver). ⚠️ Novu wire-up pending (#125) — `notify` action is a stub.                                                                                       |
| 2B    | Module system + standard module configs    | [#13](../../issues/13)                        | PrabhuVijit | ✅ Done | 100 | Module registry, seed runner, installModule/uninstallModule API, all 7 module seeds, admin modules UI, view_configs. `entity.created`/`entity.assigned` triggers now fire (#126, PR #138, 2026-07-09).                                                   |
| 2C    | Customer portal + agent UI                 | [#14](../../issues/14)                        | PrabhuVijit | ✅ Done | 100 | Generic entity list/detail/form in admin-ui + portal, workflow action buttons, view_configs driven field order                                                                                                                                           |
| 2D    | No-code builders + reporting               | [#15](../../issues/15)                        | PrabhuVijit | ✅ Done | 100 | PR #107 (admin-ui) + PR #115 (export API + workflow canvas) merged. Automation wizard, saved views, export (sync + async BullMQ), workflow visual editor (canvas save, drag-reorder, SVG arcs, initial-state guard). Metabase embed deferred to Phase 3. |
| 2-PRE | Pre-pilot engine hardening                 | [#76](../../issues/76)–[#84](../../issues/84) | PrabhuVijit | ✅ Done | 100 | ioredis migration, idempotency pre-lock, bulkCreate cache, deleteEntity round-trip, error messages, ActionConfig union, migration renumber, notify async, health endpoint                                                                                |

### Phase 2 sub-items (2B module seeds)

| Module                  | Entity types                        | Workflow                                        | Seed SQL    | Status  |
| ----------------------- | ----------------------------------- | ----------------------------------------------- | ----------- | ------- |
| @modules/helpdesk       | Ticket, Comment, Article            | Open → In Progress → Pending → Resolved + SLA   | 001–004.sql | ✅ Done |
| @modules/reimbursements | Expense Claim, Receipt              | Draft → Submitted → Mgr Review → Finance → Paid | 001.sql     | ✅ Done |
| @modules/crm            | Contact, Company, Deal, Activity    | Lead → Qualified → Proposal → Won/Lost          | 001.sql     | ✅ Done |
| @modules/projects       | Project, Task, Milestone            | Backlog → In Progress → In Review → Done        | 001.sql     | ✅ Done |
| @modules/hrms           | Employee, Department, Leave Request | Draft → Submitted → Approved/Rejected           | 001.sql     | ✅ Done |
| @modules/invoicing      | Invoice, Quote, Payment             | Draft → Sent → Paid/Overdue/Cancelled           | 001.sql     | ✅ Done |
| @modules/procurement    | Purchase Order, Vendor, RFQ         | Draft → Approved → Sent → Fulfilled             | 001.sql     | ✅ Done |
| @modules/tender         | Tender, Costing Task (child ticket) | Draft → Published → Bidding → Awarded/Closed    | 001–004.sql | ✅ Done |

### Phase 2 — out-of-band feature work (PR #144, 2026-07-16)

Built after Phase 2 was marked 100% complete; not tracked against the original 2A–2D
issue numbers since none of them anticipated this feature set. Recorded here so the
tracker reflects ground truth rather than only the original plan.

| Feature                                | Status  | Notes                                                                                                 |
| -------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| Child tickets (hierarchical sub-tasks) | ✅ Done | `packages/entity-engine/src/child-relations.ts`; configurable depth/fan-out limits per workflow       |
| Tender module (8th standard module)    | ✅ Done | See table above — uses child tickets for costing/approval sub-tasks                                   |
| Access-request flow                    | ✅ Done | Request/list/resolve routes + `access_requests` table (migration 0028, grant fixed in 0032)           |
| Ticket/comment attachments             | ✅ Done | Presigned S3-compatible uploads, gated by the same record-level access check                          |
| "My Tickets" user-scoped view          | ✅ Done | `GET /entities/my-tickets` — owned + mentioned + child tickets, per-workflow counts                   |
| Multiple workflow admins               | ✅ Done | `workflows.assigned_to` array (migration 0025)                                                        |
| Pre-PR security hardening pass         | ✅ Done | 12 blockers + 2 low-severity findings from external review fixed — see PR #144 description for detail |

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
4. Run session-start checks:
   - `gh issue list --state open --label phase:2` — hardening sprint (must close before 3A starts)
   - `gh issue list --state open --label phase:3` — Phase 3 feature tracks
