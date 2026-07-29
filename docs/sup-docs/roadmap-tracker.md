# Platform Roadmap Tracker

**Last updated:** 2026-07-25 (reconciliation — 8 PRs merged 2026-07-23/24 closing #128, #129, #141,
#160, #167, #168, #170, plus ADR-005 and ADR-006 accepted, resolving both open questions the
2026-07-22 reconciliation left for a human. Only **#125** remains open from the original
pre-Phase-3 hardening backlog. #181 (#136/ADR-007 RLS) merged 2026-07-25. Two PRs open awaiting
review: #186 (#182–185 nit-bugs), #188 (#187/#171/#150/#148/#110 nit-bugs).)
**Previously:** 2026-07-24 (`workflow` branch — workflow builder UX pass, cascading-rename fix,
template naming/validation bugfixes, template visibility governance (new, ad-hoc, not on the
tracked Phase 3 backlog), and the Docs guardrail-pipeline stage — see week-log.md 2026-07-24 for
detail.); 2026-07-16 (PR #144 — child tickets, tender module (8th standard module), access-request flow, attachments, "My Tickets" view, multi-admin workflows, plus a pre-PR security hardening pass — see "Out-of-band feature work" under Phase 2 below)
**Team model:** AI-first (Claude Code as primary engineering partner)
**Tracking:** Update `% done` and `Status` each session. Log milestones in [week-log.md](week-log.md).

---

## Summary scorecard

| Phase                           | Tracks              | Done            | % Complete | Gate                                                                                                                      |
| ------------------------------- | ------------------- | --------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| Phase 1 — Foundation            | 5 tracks + security | 5/5 + security  | **100%**   | All phase:1 issues closed                                                                                                 |
| Phase 2 — First Customer Apps   | 4 tracks            | 4/4 + hardening | **~95%**   | Pre-Phase 3 hardening: only **#125** (notify→Novu) remains open; #136/ADR-007 RLS closed via PR #181 (merged 2026-07-25). |
| Phase 3 — Scale & Extensibility | 5 tracks            | 0/5             | **0%**     | Public launch / marketplace — not started, needs human planning sign-off per `CLAUDE.md`                                  |

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

| Issue                  | Title                                           | Decision                                                                                                                   | Gate       |
| ---------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------- |
| [#3](../../issues/3)   | Workflow reliability gaps (tracker)             | ✅ Closed — items 1–3 done (#59–61), item 4 tracked in #62                                                                 | —          |
| [#64](../../issues/64) | Transition rollback / undo policy               | ✅ Closed — Option A: irreversible by design, ADR-002 WE-02 resolved, `engine.ts` comment added                            | —          |
| [#2](../../issues/2)   | SSRF + PII leakage gaps                         | ✅ Closed — PR #85; SSRF block + PII redaction + cross-tenant ref guard                                                    | —          |
| [#5](../../issues/5)   | Tenant lifecycle + audit log + outbox retention | ✅ Closed — PR #86; lifecycle service, purge worker, audit entries                                                         | 2A         |
| [#4](../../issues/4)   | Schema cache stampede + `redis.keys()`          | 🟡 Deferred — only bites at scale; fix before second pilot customer / load testing                                         | Pre-GA     |
| [#62](../../issues/62) | Workflow version GC + stuck instance recovery   | 🟡 Deferred — gated on 2D (workflow editor); pilot uses fixed seed SQL. 2D shipped 2026-07-22 — revisit.                   | Before 2D  |
| [#65](../../issues/65) | Parallel approval edge cases                    | 🟡 Deferred (phase:3) — off-limits for pilot; sequential-only approval; see `.claude/context/parallel-approval-pattern.md` | Post-pilot |

---

## Phase 2 — First Customer-Ready Apps

**Goal:** Helpdesk, reimbursements, CRM live for pilot customers. Modules are pure config (seed SQL + UI views only).
**Exit test:** Penetration test (tenant isolation) passes before any pilot is onboarded.

| ID    | Feature / Track                            | GH Issue(s)                                   | Owner       | Status  | %   | Notes                                                                                                                                                                                                                                                                                                  |
| ----- | ------------------------------------------ | --------------------------------------------- | ----------- | ------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2A    | Platform Services — Novu, files, audit log | [#12](../../issues/12)                        | PrabhuVijit | ✅ Done | 100 | All phases complete. ⚠️ Novu wire-up still pending — **#125 is the only open pre-Phase-3 hardening item** — `notify` action is a stub.                                                                                                                                                                 |
| 2B    | Module system + standard module configs    | [#13](../../issues/13)                        | PrabhuVijit | ✅ Done | 100 | Module registry, seed runner, installModule/uninstallModule API, all 7 core module seeds + `tender` (optional, ADR-005), admin modules UI, view_configs. `entity.created`/`entity.assigned` triggers fire (#126).                                                                                      |
| 2C    | Customer portal + agent UI                 | [#14](../../issues/14)                        | PrabhuVijit | ✅ Done | 100 | Generic entity list/detail/form in admin-ui + portal, workflow action buttons, view_configs driven field order                                                                                                                                                                                         |
| 2D    | No-code builders + reporting               | [#15](../../issues/15)                        | PrabhuVijit | ✅ Done | 100 | Automation wizard, saved views, export (sync + async BullMQ, [#93](../../issues/93)/[#94](../../issues/94)), workflow visual editor + canvas edit ops ([#98](../../issues/98)/[#99](../../issues/99)/[#100](../../issues/100), all shipped in PR #115 2026-06-18). Metabase embed deferred to Phase 3. |
| 2-PRE | Pre-pilot engine hardening                 | [#76](../../issues/76)–[#84](../../issues/84) | PrabhuVijit | ✅ Done | 100 | ioredis migration, idempotency pre-lock, bulkCreate cache, deleteEntity round-trip, error messages, ActionConfig union, migration renumber, notify async, health endpoint                                                                                                                              |

### Phase 2 sub-items (module seeds)

| Module                  | Category (ADR-005) | Entity types                        | Workflow                                        | Status                                                                    |
| ----------------------- | ------------------ | ----------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| @modules/helpdesk       | core               | Ticket, Comment, Article            | Open → In Progress → Pending → Resolved + SLA   | ✅ Done                                                                   |
| @modules/reimbursements | core               | Expense Claim, Receipt              | Draft → Submitted → Mgr Review → Finance → Paid | ✅ Done                                                                   |
| @modules/crm            | core               | Contact, Company, Deal, Activity    | Lead → Qualified → Proposal → Won/Lost          | ✅ Done                                                                   |
| @modules/projects       | core               | Project, Task, Milestone            | Backlog → In Progress → In Review → Done        | ✅ Done                                                                   |
| @modules/hrms           | core               | Employee, Department, Leave Request | Draft → Submitted → Approved/Rejected           | ✅ Done                                                                   |
| @modules/invoicing      | core               | Invoice, Quote, Payment             | Draft → Sent → Paid/Overdue/Cancelled           | ✅ Done                                                                   |
| @modules/procurement    | core               | Purchase Order, Vendor, RFQ         | Draft → Approved → Sent → Fulfilled             | ✅ Done                                                                   |
| @modules/tender         | optional (ADR-005) | Tender                              | Draft → BOQ → Costing Review → Docs → Submitted | ✅ Done — `modules.category` column itself not yet built, tracked as #165 |

`tender` was shipped (PR #144, 2026-07-16) and formally ratified as the platform's 8th module by
ADR-005 (accepted 2026-07-23) — resolving the "is `tender` in scope" question the 2026-07-22
reconciliation left open. `architecture-brief.md`'s module map still needs a pass to reflect this
(it currently lists a never-built `inventory` module instead — see doc audit, 2026-07-24).

### Per-workflow ownership/admin model (PR #155) — ratified

ADR-006 (accepted 2026-07-24) formally adopts the per-workflow ownership/admin authorization model
PR #155 shipped 2026-07-21 as **permanent, accepted policy** — resolving the second open question
from the 2026-07-22 reconciliation. Its own follow-up items:

- **Closed:** `grant-access.ts` didn't accept workflow-admin callers the same way
  `resolve-access-request.ts` does — filed as #167, closed via PR #179 (2026-07-24).
- **Deferred, tracked:** transition guards not consulting per-instance `__accessUsers` grants — an
  accepted v1 limitation per `docs/specs/tender-management.md`, not yet its own issue.
- **RLS for the four workflow-config tables** — spun out as its own ADR-007 (accepted 2026-07-24,
  merged via PR #181 on 2026-07-25) rather than folded into ADR-006.

---

## Pre-Phase-3 hardening backlog — status

Originally surfaced by an external consulting review (2026-06-29); the review docs themselves
were consolidated into [docs/reviews/pending-review-findings.md](../reviews/pending-review-findings.md)
2026-07-24 (only still-open findings kept). #126/#127 jumped the original queue per that review's
severity ranking. As of 2026-07-24:

| Issue                        | Title                                                               | Status                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [#121](../../issues/121)     | RLS under real role (`SET LOCAL ROLE app_user`)                     | ✅ Closed — PR #135                                                                                         |
| [#122](../../issues/122)     | Isolation tests run as `app_user`, not superuser                    | ✅ Closed — alongside #121                                                                                  |
| [#126](../../issues/126)     | `entity.created`/`entity.assigned` triggers never fire              | ✅ Closed — PR #138                                                                                         |
| [#127](../../issues/127)     | `setEntityState`/`bulkSetState` unguarded state side-door           | ✅ Closed — PR #155                                                                                         |
| [#120](../../issues/120)     | Automation double-trigger (depth resets on outbox path)             | ✅ Closed                                                                                                   |
| [#123](../../issues/123)     | Automation queue has no retries                                     | ✅ Closed                                                                                                   |
| [#124](../../issues/124)     | Auth middleware writes on every request                             | ✅ Closed                                                                                                   |
| [#128](../../issues/128)     | OpenBao + MinIO commented out of docker-compose                     | ✅ Closed — PR #173 (2026-07-23), idempotency follow-up PR #178 (2026-07-24)                                |
| [#129](../../issues/129)     | Worker has no health endpoint                                       | ✅ Closed — PR #175 (2026-07-24)                                                                            |
| [#141](../../issues/141)     | `pnpm lint` is a repo-wide no-op                                    | ✅ Closed — PR #166                                                                                         |
| [#136](../../issues/136)     | RLS for entity_types/workflows/workflow_states/workflow_transitions | ✅ Closed — ADR-007 accepted, merged via PR #181 (2026-07-25)                                               |
| **[#125](../../issues/125)** | **`notify` action is a stub — Novu never wired up**                 | **Only item still fully open** — needs a real outbox-pattern delivery worker, bigger than originally scoped |

### Found since the 2026-06-29 consulting review, now also closed or in review

| Issue                                                                        | Title                                                                        | Status                            |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------- |
| [#168](../../issues/168)                                                     | Shadow-workflow entity-type-ownership escalation                             | ✅ Closed — PR #172               |
| [#170](../../issues/170)                                                     | `installModule`'s `workflowName` rename dead for non-templated seed files    | ✅ Closed — PR #174               |
| [#167](../../issues/167)                                                     | `grant-access.ts` should accept workflow-admin callers                       | ✅ Closed — PR #179               |
| [#160](../../issues/160)                                                     | `setEntityState`/`bulkSetState` don't validate target state                  | ✅ Closed — PR #180               |
| [#176](../../issues/176)                                                     | Guardrail hooks: shared state clobbers across branches; worktree bypass      | ✅ Closed — PR #177               |
| [#171](../../issues/171)                                                     | helpdesk's redundant non-idempotent `001_seed.sql`                           | PR #188 open, not yet merged      |
| [#182](../../issues/182)–[#185](../../issues/185)                            | Nit-bugs from PR #175/#177/#179/#180 reviews                                 | PR #186 open, not yet merged      |
| [#187](../../issues/187)                                                     | `TRANSITION_LOCKED` falls through to 500 in `handle-workflow-error.ts`       | PR #188 open, not yet merged      |
| [#150](../../issues/150), [#148](../../issues/148), [#110](../../issues/110) | Small housekeeping (gitignore, corepack hash, pretest script)                | PR #188 open, not yet merged      |
| [#143](../../issues/143)                                                     | Automation-triggered transitions absent from outbox (Phase 3A connector gap) | Open — assigned to Bikash Barnwal |

**Informally assigned via issue-comment `@mentions` (GitHub's `assignees` field isn't used in this
repo) — not tracked here since ownership changes faster than this doc; see a local, gitignored
`open-issues-tracker.md` in this same directory if present, or re-check `gh issue view <N>
--json comments` for current assignment:** #161, #162, #163, #165 → Tushar Sharma. #143, #125 →
Bikash Barnwal.

---

## Phase 3 — Scale & Extensibility

**Goal:** Platform extensible by third parties. Connector marketplace, plugin system, AI layer, first sector package.
**Exit test:** External developer ships a connector or plugin using public SDK only.
**Status:** Not started. Requires human planning sign-off per `CLAUDE.md` before 3A begins.

| ID    | Feature / Track                                                     | GH Issue(s)            | Owner | Status         | %   |
| ----- | ------------------------------------------------------------------- | ---------------------- | ----- | -------------- | --- |
| 3A    | Integration layer — connector runtime, webhook gateway, marketplace | [#16](../../issues/16) | —     | 🔴 Not started | 0   |
| 3B    | Plugin system — Module Federation, slot registry, lifecycle service | [#17](../../issues/17) | —     | 🔴 Not started | 0   |
| 3C    | AI layer — automation gen, workflow suggestion, RAG, usage metering | [#18](../../issues/18) | —     | 🔴 Not started | 0   |
| 3D    | Observability + compliance — OTel, Prometheus, GDPR, audit          | [#19](../../issues/19) | —     | 🔴 Not started | 0   |
| 3-OPS | Deferred ops/compliance/infra concerns                              | [#6](../../issues/6)   | —     | 🔴 Not started | 0   |

Deferred items gated on Phase 3 / later triggers (unchanged from Phase 1 carry-over triage):
[#4](../../issues/4) (schema cache, defer until load testing), [#62](../../issues/62) (workflow
version GC, defer until 2D workflow editor — 2D shipped 2026-07-22, revisit), [#65](../../issues/65)
(parallel approval, off-limits until Phase 3 per `CLAUDE.md`).

---

## How to update this doc

1. When a GH issue closes → update `Status` to ✅ Done, log date in [week-log.md](week-log.md)
2. When a track is partially done → update `%` to estimated progress and add a note
3. When a new sub-item is identified → add a row, create a GH issue, link it
4. Run session-start checks:
   - `gh issue list --state open --label phase:2` — hardening sprint (must close before 3A starts)
   - `gh issue list --state open --label phase:3` — Phase 3 feature tracks
   - `gh pr list --state open` — anything awaiting review/merge (as of 2026-07-25: #186, #188, #189,
     #205 — #181/#190 merged 2026-07-25)
