# Phase Development Timeline — AI-First Team

**Team model:** Small AI-first team. Claude Code handles implementation; humans drive architecture decisions, reviews, and product judgment.
**Pacing assumption:** ~5 active engineering days per week. Phase 1 set the baseline velocity.

---

## Velocity baseline (from Phase 1)

| Metric               | Value                                           |
| -------------------- | ----------------------------------------------- |
| Phase 1 duration     | ~7 active days (2026-05-14 to 2026-05-21)       |
| PRs merged           | 17 PRs                                          |
| Issues closed        | 20+ issues                                      |
| PRs/day              | ~2.4                                            |
| Engine lines shipped | ~4,000 (entity + workflow + automation engines) |
| Test coverage        | ≥80% core, full isolation suite                 |

**Key insight:** Config-first architecture front-loaded the hard work into Phase 1. Phase 2 modules are seed SQL + UI wiring — expected velocity is higher per feature shipped, lower risk per change.

---

## Projected timeline

```
Week 1-2   May 13–24    Phase 1 complete ✅
Week 3     May 25–31    Phase 2 kick-off: triage carry-overs, start 2A
Week 4-5   Jun 1–14     2A platform services + 2B module system
Week 6-7   Jun 15–28    2B module seeds (7 modules) + 2C portal/UI
Week 8     Jun 29–Jul 5 2D no-code builders, Phase 2 exit testing
           Jul 6        Pilot customer onboarding gate (pen test required)
Week 9+    Jul 7+       Phase 3 begins
```

> Dates are projections. Adjust in [week-log.md](week-log.md) as actuals come in.

---

## Phase 1 — Foundation

**Duration:** 2026-05-13 to 2026-05-21 (actual)
**Team:** abmish (auth/security), PrabhuVijit (engines)

```
Week 1 (May 13–18)
  ├─ Scaffold + ADRs + issue backlog
  ├─ 1A: Infrastructure, tenancy, secrets, OpenBao
  ├─ 1B: Zitadel JWT, RBAC, API keys
  └─ 1C: Entity engine (CRUD, bulk, search, isolation)

Week 2 (May 19–21)
  ├─ 1D: Workflow engine (executeTransition, SLA, idempotency)
  ├─ 1E: Automation engine (outbox, rule executor, circuit breaker)
  └─ Security hardening sprint (ReDoS, cross-tenant, API key hardening)
```

**Exit criteria met:** ✅ All 5 tracks closed, security review passed, RLS isolation tests green.

---

## Phase 2 — First Customer-Ready Apps

**Target:** 2026-05-25 to ~2026-07-05 (6 weeks)
**Exit gate:** Penetration test passes, pilot customer onboarding approved.

```
Week 3 (May 25–31)  — Platform foundation
  ├─ Triage: close or defer open carry-overs (#2, #3, #4, #5, #62, #64, #65)
  ├─ 2A start: @platform/notifications (Novu), @platform/files (S3)
  └─ 2A: audit log table + append-only read API

Week 4 (Jun 1–7)   — Platform services complete, module system
  ├─ 2A finish: view_configs, saved views, OpenAPI spec
  ├─ 2B start: modules table, module install/uninstall, seed runner
  └─ 2B: feature flags + admin module management UI

Week 5 (Jun 8–14)  — Module seeds (7 modules)
  ├─ Helpdesk seed (Ticket, Comment, Article + SLA workflow)
  ├─ Reimbursements seed (Expense Claim, multi-level approval)
  ├─ CRM seed (Contact, Company, Deal, pipeline workflow)
  ├─ Projects seed (Project, Task, kanban workflow)
  └─ HRMS seed (Employee, Leave Request, approval workflow)

Week 6 (Jun 15–21) — Portal + agent UI
  ├─ 2C: Config-driven entity list view (reads view_configs)
  ├─ 2C: Config-driven entity detail view + form
  ├─ 2C: Workflow action buttons (getAvailableTransitions)
  └─ Invoicing + Procurement seeds

Week 7 (Jun 22–28) — No-code builders
  ├─ 2D: Automation builder UI (CRUD automation_rules)
  ├─ 2D: Workflow editor UI (CRUD workflows/states/transitions)
  └─ 2D: Metabase embed (read-only analytics views)

Week 8 (Jun 29–Jul 5) — Exit testing
  ├─ Penetration test (tenant isolation — mandatory)
  ├─ Full e2e test pass on all 5 priority modules
  └─ Pilot onboarding runbook written
```

**Module priority for pilot:** Helpdesk > Reimbursements > CRM (in that order).

---

## Phase 3 — Scale & Extensibility

**Target start:** 2026-07-07 (post-pilot onboarding)
**Duration:** 8–12 weeks depending on AI layer scope

```
3A — Integration layer (2-3 weeks)
  └─ Connector runtime, webhook gateway, marketplace scaffold

3B — Plugin system (2-3 weeks)
  └─ Module Federation, slot registry, lifecycle service

3C — AI layer (2-3 weeks)  ← highest value, likely to expand
  └─ Automation generation, workflow suggestion, RAG, usage metering

3D — Observability + compliance (ongoing, starts early)
  └─ OTel, Prometheus, GDPR tooling, audit query UI
```

---

## AI-first team operating model

**Each feature track follows this pattern:**

1. **Spec session** (~30 min): describe the track, reference the ADR and existing code, identify edge cases
2. **Generation pass**: Claude Code implements with tests in one session
3. **Review pass**: human reviews output, security check, `gh pr create`
4. **`/ultrareview` pass**: multi-agent cloud review on the PR before merge
5. **Log session**: update [week-log.md](week-log.md) and [roadmap-tracker.md](roadmap-tracker.md)

**Where humans must stay in the loop:**

- Architecture decisions (write an ADR, don't just code)
- Security-sensitive routes (auth, tenant isolation, file access)
- Pilot customer interactions and onboarding
- Phase exit decisions (don't advance phases without explicit sign-off)

**Totem: the config-first test**
Before shipping any new module feature, ask: did this require any TypeScript changes outside of `packages/*` or `apps/*`? If yes, something has gone wrong. Seed SQL only.
