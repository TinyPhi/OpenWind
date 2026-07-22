# Platform Roadmap Tracker

**Last updated:** 2026-07-22 (doc reconciliation — #127 closed via PR #155; surfaced PRs
#144/#151/#152/#155 as shipped-but-unclassified work, see "Unclassified work" section below)
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

---

## Unclassified work — shipped 2026-07-16 to 2026-07-21, not yet phase-tracked

Flagged during the 2026-07-22 doc reconciliation. Four PRs merged real, tested functionality
that doesn't fit anywhere in the Phase 1/2/3 structure above:

| PR   | Merged     | What it added                                                                          | Spec doc                                                         |
| ---- | ---------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| #144 | 2026-07-16 | Child tickets; new `modules/tender` vertical; access-request/grant flow; security pass | `docs/specs/child-tickets.md`, `docs/specs/tender-management.md` |
| #151 | 2026-07-21 | Zitadel org-id → tenant mapping; `read_only` ACL level                                 | `docs/specs/tenant-org-id-mapping.md` (+ tasks/rollout)          |
| #152 | 2026-07-21 | Request-access UI on record detail (replaces bare 404)                                 | —                                                                |
| #155 | 2026-07-21 | Per-workflow ownership/admin model; #144 follow-ups; closes #127                       | related: `docs/specs/user-scoped-records-view.md`                |

This wasn't cowboy work — each feature has a real spec doc, and two have their own
acceptance-criteria task files — but it landed outside the `openwind-loop` (no plan-lock, no
PROGRESS.md entries for the feature work itself) and outside this tracker, so none of it has
been reconciled against the documented module list or Phase 3 tracks until now.

**Not classified here on purpose** — this needs a human call, not a retroactive decision baked
into the tracker:

- Is `tender` an 8th standard module (alongside the 7 below), or out-of-scope/one-off? It
  doesn't appear in `architecture-brief.md`'s 8-module map either (which lists _inventory_,
  not _tender_).
- The per-workflow ownership/admin model (PR #155) is a second authorization path alongside
  RBAC — this is the kind of decision `CLAUDE.md` reserves for a human-written ADR, and none
  exists yet.
- `tender-management.md` self-flags that workflow transition guards don't consult per-instance
  access grants (`__accessUsers`) — logged there as an accepted v1 limitation, not yet decided
  on formally.

Code-level review of this batch (2026-07-22) found it solid on security fundamentals: RLS +
explicit tenant filters present on all new tables, 404-not-403 followed consistently, the
org-id mapping fails closed, and no IDOR was found in the access-request/grant/revoke flow.
One correctness gap surfaced: `setEntityState`/`bulkSetState` (closing #127) don't validate
the target state against `workflow_states`, unlike `updateEntity` — not yet filed as its own
issue.

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
