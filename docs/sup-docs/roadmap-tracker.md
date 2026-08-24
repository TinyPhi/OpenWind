# Platform Roadmap Tracker

**Last updated:** 2026-08-24 — reworked: fully-closed historical detail tables (Phase 1
carry-overs full list, module-seed detail, pre-Phase-3 hardening backlog, second consulting-review
batch) moved verbatim to
[week-log/2026-08-24-roadmap-tracker-historical-archive.md](week-log/2026-08-24-roadmap-tracker-historical-archive.md) —
this doc now tracks **current/open state only**, per its own "How to update this doc" rule below.
Added an **Open Tickets by Creator** table (previously untracked here).
**Team model:** AI-first (Claude Code as primary engineering partner)
**Tracking:** Update `% done` and `Status` each session.

---

## Summary scorecard

| Phase                           | Tracks              | Done                                  | % Complete          | Gate                                                                                                                                                                                                                                                    |
| ------------------------------- | ------------------- | ------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 1 — Foundation            | 5 tracks + security | 5/5 + security                        | **100%**            | All phase:1 issues closed                                                                                                                                                                                                                               |
| Phase 2 — First Customer Apps   | 4 tracks            | 4/4 + hardening                       | **100%**            | Pre-Phase 3 hardening complete. Superset embed (#102–#106) remains open, deferred to Phase 3 — see Open Tickets table.                                                                                                                                  |
| Phase 3 — Scale & Extensibility | 5 tracks            | 1/5 fully done (3B), 3A ~36% underway | **~26%** (weighted) | 3B shipped (PR #397, 2026-08-13) with 2 known gaps (#433); 3A in progress; 3C/3D/3-OPS not started — no ADR yet for either, starting either is a human scope call per `agent-behaviour.md`'s general "no phase advance without explicit sign-off" rule. |

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

Full carry-over triage detail (2026-05-22): archived. Two items remain open/deferred — see the
Open Tickets table: **#4** (schema cache/`redis.keys()`, deferred until load testing) and **#65**
(parallel approval edge cases, off-limits regardless of Phase 3 progress).

---

## Phase 2 — First Customer-Ready Apps

**Goal:** Helpdesk, reimbursements, CRM live for pilot customers. Modules are pure config (seed SQL + UI views only).
**Exit test:** Penetration test (tenant isolation) passes before any pilot is onboarded.

| ID    | Feature / Track                            | GH Issue(s)                                   | Owner       | Status  | %   | Notes                                                                                                                                                                                                                |
| ----- | ------------------------------------------ | --------------------------------------------- | ----------- | ------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2A    | Platform Services — Novu, files, audit log | [#12](../../issues/12)                        | PrabhuVijit | ✅ Done | 100 | All phases complete, including Novu wire-up (PR #211, 2026-07-29).                                                                                                                                                   |
| 2B    | Module system + standard module configs    | [#13](../../issues/13)                        | PrabhuVijit | ✅ Done | 100 | Module registry, seed runner, installModule/uninstallModule API, all 7 core module seeds + `tender` (optional, ADR-005), admin modules UI, view_configs. See archive for the full module/entity-type/workflow table. |
| 2C    | Customer portal + agent UI                 | [#14](../../issues/14)                        | PrabhuVijit | ✅ Done | 100 | Generic entity list/detail/form in admin-ui + portal, workflow action buttons, view_configs driven field order                                                                                                       |
| 2D    | No-code builders + reporting               | [#15](../../issues/15)                        | PrabhuVijit | ✅ Done | 100 | Automation wizard, saved views, export, workflow visual editor. Metabase/Superset embed (#102–#106) deferred to Phase 3, still open — see Open Tickets table.                                                        |
| 2-PRE | Pre-pilot engine hardening                 | [#76](../../issues/76)–[#84](../../issues/84) | PrabhuVijit | ✅ Done | 100 | ioredis migration, idempotency pre-lock, bulkCreate cache, deleteEntity round-trip, error messages, ActionConfig union, migration renumber, notify async, health endpoint                                            |

Module-seed detail, per-workflow ownership/admin model detail (ADR-006), and the full
pre-Phase-3/second-consulting-review closed-issue tables: all archived — see
[the archive file](week-log/2026-08-24-roadmap-tracker-historical-archive.md). The one still-open
item from that history is tracked via ADR-006 (per-instance `__accessUsers` grants not consulted
by transition guards — accepted v1 limitation, not yet its own issue).

---

## Phase 3 — Scale & Extensibility

**Goal:** Platform extensible by third parties. Connector marketplace, plugin system, AI layer, first sector package.
**Exit test:** External developer ships a connector or plugin using public SDK only.
**Status:** 3A planning complete — ADR-008/009/010 accepted 2026-08-06 (staged implementation
sequence in `.claude/context/phase-3-primer.md`). Implementation started 2026-08-09 (Stage 0).
3B shipped 2026-08-13 (PR #397, all three phases), but carries 2 corrections found during
ADR-011's adversarial review (2026-08-19): T3 (wrapped DB client + wired governor limits) and T4
(SDK deprecation policy, #433) are marked done in `plugin-system-tasks.md` but aren't actually
built, and no plugin can run backend code (routes/hooks/jobs) yet — only migrations execute.
3C/3D have no ADR yet and no track has picked them up; starting either is a human scope decision.

| ID    | Feature / Track                                                     | GH Issue(s)            | Owner | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | %   |
| ----- | ------------------------------------------------------------------- | ---------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 3A    | Integration layer — connector runtime, webhook gateway, marketplace | [#16](../../issues/16) | —     | 🟡 In progress — Stage 0 + Stage 1 (ADR-008 core) done; Stage 2 scopes-track discriminator (#370) landed 2026-08-12; runtime track (#362/#363/#365/#364) landed 2026-08-12/13, #366 (polling scheduler) + #367 (kill switch) landed 2026-08-18. #368/#369 (connectors, marketplace UI) not started. Inbound partner API Tier 1 (#344, ADR-010) actively in progress under **ADR-012** (concrete Tier-1 design, merged 2026-08-20 — see #471 for a process note on how it was accepted) — Phase C PRs #467–#470 (comment posting, sub-ticket creation, tag resolution, auto-grant-on-mention). | 36  |
| 3B    | Plugin system — Module Federation, slot registry, lifecycle service | [#17](../../issues/17) | —     | 🟡 Done as scoped, 2 gaps — see Status note above and #433.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 90  |
| 3C    | AI layer — automation gen, workflow suggestion, RAG, usage metering | [#18](../../issues/18) | —     | 🔴 Not started — carries ADR-008 Decision #5's re-evaluation gate (agent/delegation identity, deferred until 3C's scope is revisited — see `.claude/context/phase-3-primer.md`)                                                                                                                                                                                                                                                                                                                                                                                                               | 0   |
| 3D    | Observability + compliance — OTel, Prometheus, GDPR, audit          | [#19](../../issues/19) | —     | 🔴 Not started                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 0   |
| 3-OPS | Deferred ops/compliance/infra concerns                              | [#6](../../issues/6)   | —     | 🔴 Not started                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 0   |

---

## Open Tickets by Creator

Every currently-open GitHub issue, who created it, and what area it belongs to. Regenerate with
`gh issue list --state open --json number,title,author,createdAt --repo TinyPhi/OpenWind` — don't
hand-maintain the createdAt/author columns; only the Area/Notes column needs a human/agent judgment
call.

| Issue                    | Title                                                                              | Created by     | Created    | Area / Phase             | Notes                                                                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------- | -------------- | ---------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [#471](../../issues/471) | governance: ADR-012 self-accepted and bundled into an unrelated migration PR       | abmish         | 2026-08-24 | Process / ADR governance | ADR-012 (third-party API) was authored+accepted in one commit bundled inside PR #439 (described as migration-only); needs human review of whether the process gap matters here |
| [#455](../../issues/455) | security: OpenBao dev-mode exposed on 0.0.0.0:8200 with a hardcoded root token     | abmish         | 2026-08-21 | Security / infra         | Unassigned, no PR yet                                                                                                                                                          |
| [#454](../../issues/454) | chore(dx): postgres's host port binds to 0.0.0.0 with no loopback restriction      | abmish         | 2026-08-21 | Security / infra         | Unassigned, no PR yet                                                                                                                                                          |
| [#436](../../issues/436) | Flaky isolation tests: outbox-poller-automation-exclusion / -dedup-race            | abmish         | 2026-08-20 | Reliability / test infra | Blocks `pnpm test:isolation` exit-condition gate intermittently                                                                                                                |
| [#433](../../issues/433) | docs(adr): write ADR for plugin system (3B) design decisions                       | abmish         | 2026-08-19 | 3B / ADR                 | Assigned to abmish                                                                                                                                                             |
| [#432](../../issues/432) | ADR needed: notification SLA / retry / escalation policy                           | abmish         | 2026-08-19 | ADR backlog              | 🟡 Accepted as `docs/decisions/ADR-014-notification-sla-retry-escalation.md` (2026-08-24) — issue still open on GitHub, close once confirmed                                   |
| [#431](../../issues/431) | ADR needed: unified rate-limiting strategy                                         | abmish         | 2026-08-19 | ADR backlog / 3A         | 🟡 Accepted as `docs/decisions/ADR-013-unified-rate-limiting-strategy.md` (2026-08-24) — issue still open on GitHub, close once confirmed                                      |
| ~~#430~~                 | ~~[ADR-008] OQ-2/OQ-3: API-key grace period (90d) / forced-rotation window (30d)~~ | abmish         | 2026-08-19 | 3A / ADR-008 sign-off    | ✅ Closed 2026-08-24 — 90d/30d signed off, ADR-008's OQ table updated                                                                                                          |
| ~~#429~~                 | ~~[ADR-008] OQ-5: confirm partner API-key verb set~~                               | abmish         | 2026-08-19 | 3A / ADR-008 sign-off    | ✅ Closed 2026-08-24 — superseded by ADR-012 Decision #3 (per-key granular scopes, not a fixed verb set)                                                                       |
| [#403](../../issues/403) | [Discussion] Network status awareness + offline UX for apps/admin-ui               | bikash-barnwal | 2026-08-13 | Frontend / UX            | Untouched since filing                                                                                                                                                         |
| [#369](../../issues/369) | [3A/Stage 2] Connector marketplace UI                                              | abmish         | 2026-08-10 | 3A Stage 2               | Not started                                                                                                                                                                    |
| [#368](../../issues/368) | [3A/Stage 2] Email (SMTP/IMAP) + WhatsApp Business connectors                      | abmish         | 2026-08-10 | 3A Stage 2               | Not started                                                                                                                                                                    |
| [#344](../../issues/344) | Phase 3A: inbound partner API (Tier 1) — ADR-010                                   | abmish         | 2026-08-06 | 3A / ADR-010             | In progress — Phase C PRs #467–#470                                                                                                                                            |
| [#296](../../issues/296) | perf: Postgres connection pool ceiling (DATABASE_POOL_MAX=10)                      | abmish         | 2026-08-01 | Performance              | Blocked on load-test data                                                                                                                                                      |
| [#200](../../issues/200) | frontend: zero internationalization — all UI strings hardcoded English             | abmish         | 2026-07-24 | Frontend                 | Scaffolding only (PR #272), ~55/57 files remain                                                                                                                                |
| [#198](../../issues/198) | a11y: no accessibility floor on modals                                             | abmish         | 2026-07-24 | Frontend / a11y          | Waves 1–2 shipped, 2 items deliberately deferred, closure is a maintainer call                                                                                                 |
| [#192](../../issues/192) | ops: no backup / disaster-recovery runbook exists                                  | abmish         | 2026-07-24 | Ops                      | Mechanical piece shipped (PR #286), RPO/RTO policy still open                                                                                                                  |
| [#106](../../issues/106) | [2D] No-code builders + reporting — Phase 2 tracker                                | PrabhuVijit    | 2026-06-16 | 2D (Superset)            | Parent tracker for #102–#105                                                                                                                                                   |
| [#105](../../issues/105) | [2D-T16] Superset guest-token hardening + tenant isolation test                    | PrabhuVijit    | 2026-06-16 | 2D (Superset)            | Not started                                                                                                                                                                    |
| [#104](../../issues/104) | [2D-T15] Superset embed UI — tenant dashboard + per-user dashboard tab             | PrabhuVijit    | 2026-06-16 | 2D (Superset)            | Not started                                                                                                                                                                    |
| [#103](../../issues/103) | [2D-T14] /superset/embed-token API — guest token via Superset's guest_token API    | PrabhuVijit    | 2026-06-16 | 2D (Superset)            | Not started                                                                                                                                                                    |
| [#102](../../issues/102) | [2D-T13] add Apache Superset to docker-compose + seed default dashboards           | PrabhuVijit    | 2026-06-16 | 2D (Superset)            | Not started                                                                                                                                                                    |
| [#65](../../issues/65)   | [3.7] Parallel approval stuck-instance edge cases                                  | PrabhuVijit    | 2026-05-19 | Deferred                 | Off-limits regardless of Phase 3 progress (see `.claude/context/parallel-approval-pattern.md`)                                                                                 |
| [#19](../../issues/19)   | [3D] Observability + compliance (OTel, Prometheus, GDPR, audit)                    | abmish         | 2026-05-14 | 3D tracker               | Nominally assigned to PrabhuVijit; 0% — not started                                                                                                                            |
| [#18](../../issues/18)   | [3C] AI layer — automation generation, workflow suggestion, RAG                    | abmish         | 2026-05-14 | 3C tracker               | Not started, no ADR                                                                                                                                                            |
| [#16](../../issues/16)   | [3A] Integration layer — connector runtime, webhook gateway & marketplace          | abmish         | 2026-05-14 | 3A tracker               | Parent tracker, in progress                                                                                                                                                    |
| [#15](../../issues/15)   | [2D] No-code builders + reporting (automation builder, workflow editor, Metabase)  | abmish         | 2026-05-14 | 2D tracker               | Parent tracker, Superset piece still open                                                                                                                                      |
| [#6](../../issues/6)     | Deferred: Operational, compliance & infrastructure concerns                        | abmish         | 2026-05-14 | 3-OPS tracker            | Not started, no ADR                                                                                                                                                            |
| [#4](../../issues/4)     | Performance: Schema cache & Redis efficiency gaps                                  | abmish         | 2026-05-13 | Deferred                 | Defer until load testing / pre-GA                                                                                                                                              |

---

## How to update this doc

1. When a GH issue closes → update `Status` to ✅ Done, log a new file under
   [week-log/](week-log/) (never edit `week-log.md` itself — it's frozen history, see its header)
2. When a track is partially done → update `%` to estimated progress and add a note
3. When a new sub-item is identified → add a row, create a GH issue, link it
4. **Parallel-track convention:** when a track's work happens on its own branch alongside other
   tracks (e.g. 3B/3C/3D running concurrently), edit only **that track's own row** — never the
   Summary scorecard from a track branch. Reconcile the scorecard in whichever session lands last,
   or in a dedicated periodic sync pass.
5. Regenerate the **Open Tickets by Creator** table each session with
   `gh issue list --state open --json number,title,author,createdAt --repo TinyPhi/OpenWind` —
   don't let it silently go stale; a row for a closed issue belongs in `week-log/`, not here.
6. When a historical detail table grows large and every row in it is closed, archive it verbatim
   to a new dated `week-log/` file (same pattern as this rework) rather than leaving it inline.
7. Run session-start checks:
   - `gh issue list --state open --label phase:2` — hardening sprint (must close before 3A starts)
   - `gh issue list --state open --label phase:3` — Phase 3 feature tracks
   - `gh pr list --state open` — anything awaiting review/merge
