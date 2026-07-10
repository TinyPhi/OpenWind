# OpenWind — Business & Technical Consulting Review

**Date:** 2026-06-29  
**Prompt:** _"As a top-notch business and technical consultant, review and analyze the vision, architecture, and other documents for OpenWind. What can be improved, updated, or brought up to date?"_  
**Phase:** 2 complete → Pre-Phase 3 hardening sprint in progress (#120–#129)  
**Status as of 2026-07-09:** #121 and #122 closed via [PR #135](../../pull/135) — RLS is now enforced via `SET LOCAL ROLE app_user`, and the three cross-tenant isolation tests run for real. #126 closed via [PR #138](../../pull/138) — `entity.created`/`entity.assigned` now emit to the outbox. See ✅ RESOLVED notes inline below. A new follow-up, [#136](../../issues/136), was filed during the #135 review for a related but separately-scoped gap (no RLS policy at all on `entity_types`/`workflows`/`workflow_states`/`workflow_transitions`).  
**Related reviews:** Follows the 2026-06-23 three-lens external review (CTO architecture + risk,
Product capability, UX adoption — see `week-log.md`), which reconciled CLAUDE.md/VISION.md/
db-conventions.md with code reality and first identified the #120–#129 hardening backlog. This
consulting review is a separate, later pass (Claude Code multi-agent codebase analysis) that adds
architectural depth and verifies specific claims against the codebase — it is not a re-run of the
same review.

---

## Executive Summary

OpenWind has a well-conceived, coherent architecture. The three core engines (Entity, Workflow, Automation) are substantively complete and properly layered. The config-first module model is a genuine differentiator. However, a pattern of **documentation drift** has accumulated: phase status, gating logic, and some safety claims in docs no longer match code reality. More critically, **three correctness gaps directly affect the tenant isolation guarantee** and must close before any pilot customer sees production data.

The platform is architecturally sound but not yet ready to trust with real customer data.

**Update, 2026-07-09:** Blocker 1 (RLS enforcement, #121/#122) and Blocker 3 (`entity.created`
never fires, #126) are closed — see the inline ✅ RESOLVED notes in §2 and §4/§5. Blockers 2
and 4 (#127, #125) remain open; the severity picture above still applies to those.

---

## 1. What Is Solid — Keep and Build On

| Area                                    | Verdict                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| Three-engine architecture               | Entity (~6k LOC), Workflow (~2.3k), Automation (~2k) — well-scoped, tested, correctly layered |
| Config-first module model (ADR-004)     | Zero TypeScript in `modules/`; escape hatches (script action, plugin SDK) are well-principled |
| Pessimistic-lock FSM design             | Avoiding distributed saga complexity is the right call for this scale target                  |
| ADR quality (001–004)                   | Each names rejected alternatives with reasoning — unusually rigorous                          |
| Generic UI views                        | `EntityList`/`EntityDetail`/`EntityForm` driven by `view_configs` is the right abstraction    |
| Append-only audit log                   | Design is correct; needs a retention ADR before compliance claims can be made                 |
| PROGRESS.md / week-log.md / BLOCKERS.md | Excellent session hygiene; the velocity record is a genuine asset                             |

---

## 2. Documentation Issues

### 🔴 Critical — Misleading Safety Claims

**RLS claim in db-conventions.md was "no query needs WHERE tenant_id"** — ✅ RESOLVED (docs: 2026-06-24, commit `c8531fd`; enforcement: 2026-07-08, PR #135)  
The false claim itself was caught and corrected in the 2026-06-23 external review's reconciliation session, six weeks before this consulting review was written — `db-conventions.md` and `security.md` already stated both layers were mandatory by then. PR #135 (2026-07-08) is credited separately: it closed the code-level gap (#121) by adding `SET LOCAL ROLE app_user`, and updated the docs' description of the enforcement mechanism to match.

**`platform-vision.md` Mermaid diagram shows Phase 2 as "▶ NEXT"** — ✅ RESOLVED (2026-07-08), but not as originally diagnosed  
Investigation found this isn't a stale-status bug: `platform-vision.md` uses its own Phase 0–6
long-term roadmap numbering (Phase 0 = Foundation, Phase 1 = Working Product, Phase 2 =
Integration Platform, …), which is a _different_ scheme from `CLAUDE.md`'s Phase 1/2/3
execution tracking. "Phase 2 ▶ NEXT" in that diagram correctly refers to the not-yet-started
Integration Platform work (≈ CLAUDE.md's Phase 3A) — it does not claim CLAUDE.md's Phase 2 is
incomplete. The real bug was the numbering collision itself being confusing/undocumented.  
→ Added a numbering-note callout above the diagram in `docs/platform-vision.md` mapping the
two schemes and pointing to `CLAUDE.md` as ground truth, rather than changing the (accurate)
diagram status.

**`notify` action documented as Phase 2A deliverable but is a stub**  
`actions/notify.ts` only logs — never calls Novu. `roadmap-tracker.md` marks 2A "✅ Done" without caveat.  
→ Add a note to the 2A row: "Novu wire-up pending (#125)."

**`entity.created` / `entity.assigned` never fire**  
Defined in `event-schemas.ts`, never emitted by the entity engine. Module seeds with create-triggered automations silently do nothing.  
→ Note gap in 2B module completeness row → #126.

### 🟡 Important — Stale or Inconsistent

**`roadmap-tracker.md` Phase 2 gate is 6 days out of date**  
Gate reads: "Pilot customer onboarding."  
Gate should read: "Pre-Phase 3 hardening items #120–#129 all closed."  
File: `docs/sup-docs/roadmap-tracker.md`

**ADR-004 missing from `CLAUDE.md` reference list**  
`CLAUDE.md` lists ADR-001/002/003 but not ADR-004 (Config-First Module Design, accepted 2026-05) — the most operationally important ADR for daily development decisions.

**ADR-002 resolved questions have no addendum**  
WE-02 (transitions irreversible by design, issue #64) and WE-03 (SLA recovery, issue #63) are closed. ADR-001 has a proper dated addendum (analytics, 2026-05-22); ADR-002 does not.  
→ Add Addendum section to `docs/decisions/ADR-002-workflow-engine.md`.

**Phase 1 open questions MT-02 and WE-05 never triaged**  
MT-02 (BullMQ worker tenant_id signature verification) and WE-05 (`getAvailableTransitions` as single source of truth) are marked Phase 1 but neither resolved nor re-triaged into a later phase. Close with a resolution note or add to the hardening backlog.

**Field type count discrepancy — finding retracted, no discrepancy exists**  
Verified against `architecture-brief.md`'s field-type table (15 rows: text, longtext, number,
currency, date, datetime, boolean, enum, multi_enum, user_ref, entity_ref, file, files,
formula, lookup) and `platform-vision.md`'s "all 15 types" reference — both agree at 15. No
"13 types" citation exists anywhere in the docs; the original finding's `local-setup.md`
citation was also wrong (the "15 types" line is in `platform-vision.md`). Leaving this note
in place instead of deleting the item so a future reader doesn't re-file it.

### 🟢 Minor

**Phase sequencing differs between `architecture-brief.md` and `platform-vision.md`**  
`architecture-brief.md` Phase 3 clusters connectors + AI + sector packages. `CLAUDE.md` is the ground truth. Add a header note to `architecture-brief.md`: _"Phase assignments in this document are aspirational; see `CLAUDE.md` for the current phase plan."_

**Demo credentials hard-coded in `local-setup.md`**  
`owAdmin / OpenWind1234!` appear in plain text. Replace with `<your-admin-password>` placeholder if this doc ever becomes public.

---

## 3. Architecture Integrity — Missing ADRs

Good ADR coverage for Phases 1–2. Phase 3 onwards has **zero architectural decisions documented.** Write each ADR before starting the corresponding track's spec.

| Decision Needed                                                                              | Priority                | Why It Can't Wait                                            |
| -------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------ |
| **Connector SDK** — execution model, retry/rate-limit, Trigger.dev bridge, marketplace trust | 🔴 Before 3A            | SDK is 83 lines of TypeScript interfaces; no runtime design  |
| **Plugin system** — sandboxing model, permission enforcement, Module Federation              | 🔴 Before 3B            | SDK is 50 lines of interfaces; no loader or enforcer         |
| **AI layer** — LLM selection, RAG context window, cost tracking, fallback on failure         | 🔴 Before 3C            | `packages/ai` is a 7-line Anthropic SDK wrapper              |
| **Observability** — OTel tracing, Prometheus metrics, logging destination, alerting SLAs     | 🟡 Before 3D            | No strategy documented anywhere                              |
| **Audit retention** — GDPR erasure SLA, long-term storage tier, export API                   | 🟡 Before any pilot     | ADR-001 MT-01 is open with no owner or date                  |
| **Rate limiting** — per-tenant quotas, burst allowances, enforcement layer                   | 🟡 Before public launch | No enforcement code exists                                   |
| **Notification delivery SLA** — fallback channels, retry policy, dead-letter handling        | 🟡 Before 3A            | #125 is a stub; policy completely undefined                  |
| **File encryption at rest** — S3 SSE config, CDN caching, retention policy                   | 🟡 Before any pilot     | Presigned URLs implemented; encryption strategy undocumented |

---

## 4. Codebase vs. Claims — Reality Check

| Document Claims                              | Actual State                                                                                     | Gap                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Connector marketplace (Phase 3A)             | `packages/connector-sdk`: 83 lines, types only                                                   | No orchestration, no webhook gateway, no runtime                                 |
| Plugin system (Phase 3B)                     | `packages/plugin-sdk`: 50 lines, types only                                                      | No loader, no slot registry, no permission enforcer                              |
| AI layer (Phase 3C)                          | `packages/ai`: 7 lines, `createClient()` only                                                    | No RAG, no prompt templates, no token counting                                   |
| 7 module seeds complete                      | Helpdesk: 5 structured SQL files ✅; 6 others: 1 monolithic file each                            | 6/7 lack automation rules; only helpdesk follows the 4-file pattern from ADR-004 |
| Novu notification delivery                   | `@platform/notifications` wrapper complete                                                       | `notify` action in automation engine only logs (#125)                            |
| `entity.created` / `entity.assigned` trigger | Defined in `event-schemas.ts`                                                                    | ✅ RESOLVED (PR #138, 2026-07-09) — #126 closed, now emitted by entity engine    |
| `setEntityState` / `bulkSetState`            | API exists                                                                                       | Bypasses workflow engine: no `workflow_events`, no outbox, no audit trail (#127) |
| RLS enforced per request                     | `withTenantContext` / `executeRawInTenantContext` issue `SET LOCAL ROLE app_user` before the GUC | ✅ RESOLVED (PR #135, 2026-07-08) — #121 closed                                  |
| Customer portal                              | Next.js app present, role-gated                                                                  | `file`, `user_ref`, `entity_ref`, `formula` field inputs fall back to plain text |

**Most critical gap — ✅ RESOLVED (PR #135, 2026-07-08):** The RLS enforcement chain was broken at the database role level (#121). `SET LOCAL ROLE app_user` is now added to `withTenantContext` and `executeRawInTenantContext`, and the three previously-`.skip`'d cross-tenant RLS tests now run for real and pass — the tenant isolation guarantee is proven for every table with an RLS policy. (`entity_types`/`workflows`/`workflow_states`/`workflow_transitions` still have no RLS policy at all — tracked separately in #136, isolation there remains application-layer only.)

---

## 5. Business Readiness Assessment

### Pilot Customer Readiness: NOT YET

**Blocker 1 — Security:** ✅ RESOLVED (PR #135, 2026-07-08). RLS is now enforced (#121 → #122 both closed); isolation tests pass as `app_user`, not superuser.

**Blocker 2 — Data integrity:** `setEntityState` bypasses the workflow engine entirely (#127). State changes via this path produce no audit trail and fire no automations — a GDPR and compliance risk.

**Blocker 3 — Core function:** ✅ RESOLVED (PR #138, 2026-07-09). `entity.created`/`entity.assigned` now emit to the outbox (#126 closed); automation rules triggered on entity creation/assignment are live.

**Blocker 4 — Core function:** `notify` action only logs (#125). SLA breach alerts and assignment notifications deliver nothing.

Non-blockers (important but not pilot-blocking):

- 6/7 module seeds have no default automations (functional but ship empty)
- Portal complex field types render as plain text
- Automation queue has `attempts=1` with no retry (#123)

### Phase 3 Readiness: NOT YET

All 10 hardening items (#120–#129) must close, then `.claude/context/phase-3-primer.md` must be written, before 3A planning begins. Do not parallelize.

---

## 6. Prioritized Action List

### Immediate (before any pilot conversation)

1. ~~Close #121 → #122 (RLS role + isolation tests) — security gate~~ ✅ DONE (PR #135, 2026-07-08)
2. ~~Close #126 (`entity.created`/`entity.assigned` triggers) — core function~~ ✅ DONE (PR #138, 2026-07-09)
3. Close #127 (guard `setEntityState`/`bulkSetState`) — audit/compliance
4. ~~Update `roadmap-tracker.md` Phase 2 gate wording~~ ✅ DONE (2026-07-08)
5. ~~Fix `platform-vision.md` Mermaid diagram (Phase 2 complete)~~ ✅ DONE (2026-07-08) — see note above
6. ~~Add ADR-004 to `CLAUDE.md` reference list~~ ✅ DONE (2026-07-08) — surfaced early (second, after `architecture-brief.md`) per §8's recommendation

### Before Phase 3 planning

7. Close remaining hardening items #120, #123–#125, #128–#129
8. Write ADR for Connector SDK (before 3A spec)
9. Write `.claude/context/phase-3-primer.md` (required by `CLAUDE.md` before 3A)
10. Add ADR-002 addendum (WE-02/WE-03 closure with dates and issue links)
11. Triage or close ADR-001 MT-02 and ADR-002 WE-05 open questions
12. ~~Resolve field type count discrepancy across docs~~ ✅ RETRACTED (2026-07-08) — verified 15 types in architecture-brief.md; no discrepancy exists (see §2 inline note)

### Before public launch / marketplace

13. Write ADRs for Plugin system, AI layer, Observability, Audit retention, Rate limiting, Notification SLA
14. Backfill automation rules into 6/7 module seeds (follow helpdesk 4-file pattern)
15. Fix portal field inputs for `file`/`user_ref`/`entity_ref`/`formula` types
16. Validate schema cache (60s TTL) under realistic tenant load (ADR-001 MT-03)

---

## 7. What Does NOT Need Changing

- The three-engine architecture — sound; do not refactor
- ADR-001/002/003/004 substance — good decisions, well-reasoned
- Config-first module model — correct direction; enforce it more visibly
- Drizzle + RLS migration pattern — clean; keep it
- Hono `factory.createHandlers` API pattern — consistent; keep it
- Pessimistic-lock workflow design — right call; do not second-guess it
- PROGRESS.md / week-log.md / BLOCKERS.md velocity tracking — excellent hygiene

---

## 8. Strategic Observations

**The platform is correctly narrower than the documents.**  
Architecture docs describe a Phase 5 vision (sector packages, Helm chart, SAML, multi-region). The codebase is a clean Phase 2 foundation. This is healthy — vision docs should be aspirational. But the docs need to say "Phase 5 — aspirational" more explicitly.

**ADR-004 (config-first) is the most important architectural bet.**  
It is what makes the platform scalable without a TypeScript developer per module. It deserves more prominence: surface it first in `CLAUDE.md`, consider a CI lint rule enforcing the config-first checklist at merge time, and dedicate a module-author onboarding guide to it.

**The biggest risk is not technical — it is trust.**  
The RLS gap (#121) and unguarded state mutations (#127) are proven gaps, not theoretical risks. If a pilot customer discovers cross-tenant data exposure, the platform cannot recover reputationally from that. The 10 hardening items are correctly identified as prerequisites — treat them as such.

**Phase 3 SDK stubs are placeholder scaffolds, not foundations.**  
`connector-sdk` and `plugin-sdk` are correct as type-definition placeholders, but Phase 3A/3B require real ADRs before any code is written. The connector execution model (dedicated worker process? V8 isolate? Trigger.dev bridge?) will constrain the entire marketplace design. The ADR must precede the spec.

**`packages/ai` is premature noise.**  
A 7-line Anthropic SDK wrapper with no integration points in the platform is neither useful nor harmful — but it should be explicitly labeled in `CLAUDE.md` as "stub only; no integration points until Phase 3C is designed."

---

_Generated by Claude Code (claude-sonnet-4-6) via multi-agent codebase analysis — three parallel Explore agents covering vision docs, ADRs/roadmap, and codebase-reality respectively._
