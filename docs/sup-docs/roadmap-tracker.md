# Platform Roadmap Tracker

**Last updated:** 2026-08-28 — Post-Phase-G E2E testing (via the OWTester reference client, see
`openWindTest/HOW-THIS-TESTER-WORKS.md`) surfaced a real bug: third-party transition calls always
passed `actorRoles: []`, making every role-restricted transition unreachable via the API even for
callers with legitimate ticket-level access (every real seeded workflow restricts `allowed_roles`).
Fixed on `fix/third-party-transition-role-mapping` (PR #514, spec
`docs/specs/third-party-transition-role-mapping.md`) — grants the baseline `"user"` role only
after `hasTransitionAccess` already passed, never `"admin"`/`"agent"`. PrabhuVijit's review
requested two blocking changes (test coverage gap, stale spec metadata) plus three non-blocking
suggestions, all addressed same session; re-review requested. **PR #513** (idempotency
`canonicalize` ESM/CJS crash fix + double-checked-locking restoration) is **merged** to `main` as
of 2026-08-28, after two rounds of merge-conflict reconciliation with PR #510 (an independent fix
for the same TOCTOU gap) and a CI failure (one un-awaited `computeContentHash` call in a
merged-in test) — both resolved same session. `tushar` is synced to both.
Previously — 2026-08-26 — ADR-012 Phase G ("hardening" closing gate) reached fully
implemented, T1-T12, across three stacked branches/PRs: Phase 1 (T1-T5, rate limiting/JWT
freshness/PII redaction/TLS, PR #495, CI-green), Phase 2 (T6-T7, idempotency-key support, PR
#499, CI-green, stacked on #495), and Phase 3 (T8-T12, access-log retention + tenant-purge
anonymization/deletion + final cross-phase `/security-review`, on `feat/third-party-api-phase-g-retention`,
stacked on #499, not yet a PR). The Phase 3 security review's initial "not ready" verdict (2
blocking findings — missing RLS on the new rollup table, an undocumented R11 resolution) was
resolved in the same session; spec at `docs/specs/third-party-api-phase-g-hardening.md`. Phase E
(status transitions, PR #484) and Phase F (access logs + misuse alerts, PR #489) are both merged
into upstream `main` as of that session's own conflict-resolution merges into #495/#499.
Previously — 2026-08-25 — ADR-012 Phase E (status transitions) PR #484 opened, following
Phase C (#467–#470) and Phase D Stage 1-2 (#472) merging. Reworked 2026-08-24: fully-closed
historical detail tables (Phase 1 carry-overs full list, module-seed detail, pre-Phase-3 hardening
backlog, second consulting-review batch) moved verbatim to
[week-log/2026-08-24-roadmap-tracker-historical-archive.md](week-log/2026-08-24-roadmap-tracker-historical-archive.md) —
this doc now tracks **current/open state only**, per its own "How to update this doc" rule below.
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

| ID    | Feature / Track                                                     | GH Issue(s)            | Owner | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | %   |
| ----- | ------------------------------------------------------------------- | ---------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 3A    | Integration layer — connector runtime, webhook gateway, marketplace | [#16](../../issues/16) | —     | 🟡 In progress — Stage 0 + Stage 1 (ADR-008 core) done; Stage 2 scopes-track discriminator (#370) landed 2026-08-12; runtime track (#362/#363/#365/#364) landed 2026-08-12/13, #366 (polling scheduler) + #367 (kill switch) landed 2026-08-18. #368/#369 (connectors, marketplace UI) not started. Inbound partner API Tier 1 (#344, ADR-010) actively in progress under **ADR-012** (concrete Tier-1 design, merged 2026-08-20 — process note #471, closed 2026-08-24) — Phase C PRs #467–#470 (comment posting, sub-ticket creation, tag resolution, auto-grant-on-mention) merged; Phase D Stage 1-2 PR #472 (attachments presign/upload/reference/download) merged, Stage 3 PR #475 (scan-failure handling) open; Phase E PR #484 (status transitions) open; Phase F (access logs screen, PR #489) merged 2026-08-26, generating review follow-ups #490–#498; Phase G (rate limits/JWT freshness/redaction/TLS hardening, idempotency-key support) in progress on open PRs #495/#499. Post-Phase-G E2E testing (2026-08-28) found and fixed a real transition role-mapping gap (PR #514, open, re-review requested) and an idempotency ESM/CJS crash + TOCTOU regression (PR #513, **merged**). | 42  |
| 3B    | Plugin system — Module Federation, slot registry, lifecycle service | [#17](../../issues/17) | —     | 🟡 Done as scoped, 2 gaps — see Status note above and #433.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 90  |
| 3C    | AI layer — automation gen, workflow suggestion, RAG, usage metering | [#18](../../issues/18) | —     | 🔴 Not started — carries ADR-008 Decision #5's re-evaluation gate (agent/delegation identity, deferred until 3C's scope is revisited — see `.claude/context/phase-3-primer.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 0   |
| 3D    | Observability + compliance — OTel, Prometheus, GDPR, audit          | [#19](../../issues/19) | —     | 🟡 Design complete, implementation not started — **ADR-015** (`docs/decisions/ADR-015-observability-compliance.md`) accepted 2026-08-26, settling self-hosted-vs-pluggable observability backend, `tenant_usage_daily` shape, scope reconciliation with #6, and a degrade-and-notify billing/plan-enforcement gate. Staged Stage 0–4 sequence proposed in the ADR; no stage started yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 5   |
| 3-OPS | Deferred ops/compliance/infra concerns                              | [#6](../../issues/6)   | —     | 🔴 Not started — **partial:** #6's GDPR-per-user-erasure and IP-allowlisting items are now owned/scoped by **ADR-015** (3D, Decision #4); only #6's SRI-hashes item (already shipped via 3B) and its remaining items (DR/backup, Redis SPOF, data residency, plugin-marketplace security) stay under this row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 0   |

---

## Open Tickets by Creator

Every currently-open GitHub issue, who created it, and what area it belongs to. Regenerate with
`gh issue list --state open --json number,title,author,createdAt --repo TinyPhi/OpenWind` — don't
hand-maintain the createdAt/author columns; only the Area/Notes column needs a human/agent judgment
call.

| Issue                    | Title                                                                                | Created by  | Created    | Area / Phase                | Notes                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------ | ----------- | ---------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#498](../../issues/498) | fix(redis): clear dangling setTimeout in withRedisTimeout when fn() resolves first   | PrabhuVijit | 2026-08-26 | 3A / ADR-012 Phase F review | PR #489 (Phase F) follow-up (N-03). No PR yet.                                                                                                                                                          |
| [#497](../../issues/497) | fix(redis): make auth-failure counter atomic (INCR+EXPIRE race, misuse-alerts)       | PrabhuVijit | 2026-08-26 | 3A / ADR-012 Phase F review | PR #489 follow-up (N-02). No PR yet.                                                                                                                                                                    |
| [#496](../../issues/496) | fix(third-party): handle non-apikey userId in requireTicketScope gracefully          | PrabhuVijit | 2026-08-26 | 3A / ADR-012 Phase F review | PR #489 follow-up (N-01). No PR yet.                                                                                                                                                                    |
| [#494](../../issues/494) | fix(third-party-api): confirm comment field is sanitized before executeTransition    | PrabhuVijit | 2026-08-26 | 3A / ADR-012 Phase F review | No PR yet.                                                                                                                                                                                              |
| [#493](../../issues/493) | chore(third-party-api): confirm ADR-013 rate limiting covers the transition endpoint | PrabhuVijit | 2026-08-26 | 3A / ADR-012 Phase F review | Likely addressed by open PR #495 (Phase G hardening) — confirm on merge.                                                                                                                                |
| [#492](../../issues/492) | fix(test): phase e grantAccess helper missing tenant_id filter                       | PrabhuVijit | 2026-08-26 | 3A / ADR-012 test hygiene   | No PR yet.                                                                                                                                                                                              |
| [#491](../../issues/491) | test(third-party-api): phase e isolation tests have cross-test state dependencies    | PrabhuVijit | 2026-08-26 | 3A / ADR-012 test hygiene   | No PR yet.                                                                                                                                                                                              |
| [#490](../../issues/490) | fix(third-party-api): phase e TOCTOU — assignedTo access check uses stale snapshot   | PrabhuVijit | 2026-08-26 | 3A / ADR-012 Phase F review | No PR yet.                                                                                                                                                                                              |
| [#369](../../issues/369) | [3A/Stage 2] Connector marketplace UI                                                | abmish      | 2026-08-10 | 3A Stage 2                  | Not started                                                                                                                                                                                             |
| [#368](../../issues/368) | [3A/Stage 2] Email (SMTP/IMAP) + WhatsApp Business connectors                        | abmish      | 2026-08-10 | 3A Stage 2                  | Not started                                                                                                                                                                                             |
| [#344](../../issues/344) | Phase 3A: inbound partner API (Tier 1) — ADR-010                                     | abmish      | 2026-08-06 | 3A / ADR-010                | In progress — Phase C PRs #467–#470                                                                                                                                                                     |
| [#296](../../issues/296) | perf: Postgres connection pool ceiling (DATABASE_POOL_MAX=10)                        | abmish      | 2026-08-01 | Performance                 | Blocked on load-test data                                                                                                                                                                               |
| [#200](../../issues/200) | frontend: zero internationalization — all UI strings hardcoded English               | abmish      | 2026-07-24 | Frontend                    | Scaffolding only (PR #272), ~55/57 files remain                                                                                                                                                         |
| [#198](../../issues/198) | a11y: no accessibility floor on modals                                               | abmish      | 2026-07-24 | Frontend / a11y             | Waves 1–2 shipped, 2 items deliberately deferred, closure is a maintainer call                                                                                                                          |
| [#192](../../issues/192) | ops: no backup / disaster-recovery runbook exists                                    | abmish      | 2026-07-24 | Ops                         | Mechanical piece shipped (PR #286), RPO/RTO policy still open                                                                                                                                           |
| [#106](../../issues/106) | [2D] No-code builders + reporting — Phase 2 tracker                                  | PrabhuVijit | 2026-06-16 | 2D (Superset)               | Parent tracker for #102–#105                                                                                                                                                                            |
| [#105](../../issues/105) | [2D-T16] Superset guest-token hardening + tenant isolation test                      | PrabhuVijit | 2026-06-16 | 2D (Superset)               | Not started                                                                                                                                                                                             |
| [#104](../../issues/104) | [2D-T15] Superset embed UI — tenant dashboard + per-user dashboard tab               | PrabhuVijit | 2026-06-16 | 2D (Superset)               | Not started                                                                                                                                                                                             |
| [#103](../../issues/103) | [2D-T14] /superset/embed-token API — guest token via Superset's guest_token API      | PrabhuVijit | 2026-06-16 | 2D (Superset)               | Not started                                                                                                                                                                                             |
| [#102](../../issues/102) | [2D-T13] add Apache Superset to docker-compose + seed default dashboards             | PrabhuVijit | 2026-06-16 | 2D (Superset)               | Not started                                                                                                                                                                                             |
| [#65](../../issues/65)   | [3.7] Parallel approval stuck-instance edge cases                                    | PrabhuVijit | 2026-05-19 | Deferred                    | Off-limits regardless of Phase 3 progress (see `.claude/context/parallel-approval-pattern.md`)                                                                                                          |
| [#19](../../issues/19)   | [3D] Observability + compliance (OTel, Prometheus, GDPR, audit)                      | abmish      | 2026-05-14 | 3D tracker                  | ADR-015 accepted 2026-08-26 — design settled, implementation not started. Nominally assigned to PrabhuVijit.                                                                                            |
| [#18](../../issues/18)   | [3C] AI layer — automation generation, workflow suggestion, RAG                      | abmish      | 2026-05-14 | 3C tracker                  | Not started, no ADR                                                                                                                                                                                     |
| [#16](../../issues/16)   | [3A] Integration layer — connector runtime, webhook gateway & marketplace            | abmish      | 2026-05-14 | 3A tracker                  | Parent tracker, in progress                                                                                                                                                                             |
| [#15](../../issues/15)   | [2D] No-code builders + reporting (automation builder, workflow editor, Metabase)    | abmish      | 2026-05-14 | 2D tracker                  | Parent tracker, Superset piece still open                                                                                                                                                               |
| [#6](../../issues/6)     | Deferred: Operational, compliance & infrastructure concerns                          | abmish      | 2026-05-14 | 3-OPS tracker               | GDPR-per-user-erasure + IP-allowlisting items now owned by ADR-015; SRI hashes already shipped (3B); remainder (DR/backup, Redis SPOF, data residency, plugin-marketplace security) not started, no ADR |
| [#4](../../issues/4)     | Performance: Schema cache & Redis efficiency gaps                                    | abmish      | 2026-05-13 | Deferred                    | Defer until load testing / pre-GA                                                                                                                                                                       |

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
