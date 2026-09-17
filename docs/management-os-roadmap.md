# Management OS Roadmap — Revised Phase-Wise Product Evolution

**Status:** Proposed — reflects a strategy re-alignment session, not yet ratified by ADR or
co-founder sign-off on scope/sequencing. Nothing here authorizes re-sequencing 3A/3E/3F or
pulling 3C forward on its own; see `docs/sup-docs/management-os-implementation-timeline.md`
§"What needs sign-off."
**Date:** 2026-09-17
**Relationship to other roadmap docs:** this does **not** replace
[`platform-vision.md`](platform-vision.md)'s architecture/layer model (still accurate) or its
Phase 0–6 long-range roadmap (still the aspirational end-state). It reprioritizes _what ships
next and why_, in light of a specific pivot decision: OpenWind is being positioned as a
cross-functional **leadership cockpit** — org-wide operational visibility plus one-click
action — not a single-department point tool. `CLAUDE.md`'s Current Focus table and
`docs/sup-docs/roadmap-tracker.md` remain the ground truth for live phase/track status; this
doc only reorders and reframes what to build within and after those tracks.
**Companion doc:** [`management-os-implementation-timeline.md`](sup-docs/management-os-implementation-timeline.md)
(when things happen).

---

## Why this revision

Three findings drove the reprioritization below (full analysis, market research, and sourcing
in the strategy session's artifact — ask for the link if you need the sourced version):

1. **The buyer is a CEO/COO/department head wanting org-wide visibility, not one team's
   tool.** The initial cut of this pivot narrowed to an SRE/security wedge because that's where
   the codebase happened to be furthest along (3E/3F). That was a sequencing convenience, not
   the actual ambition, and it undersold the cockpit-for-any-domain vision.
2. **Two "operating system" naming collisions constrain how features get positioned.**
   ServiceNow's 2026 "Action Fabric" / AI Control Tower repositioning, and the existing
   monday.com "Work OS" / EOS-style "Business Operating System" category, mean OpenWind cannot
   lead with "the Operating System for your business" as an open claim. The defensible feature
   differentiator is narrower and more concrete: **state reconciled live from actual systems of
   record via webhooks, plus a real enforced finite-state machine — not a board a human updates
   by hand, and not a quarterly-goals facilitation tool.** Every feature below should be
   evaluated against that claim, not against "do we have a dashboard."
3. **The agentic gap is real and needs a toehold, not a deferral.** Phase 3C (AI layer) is 0%
   complete with no ADR, and `packages/ai` is a six-line client stub, while the market's actual
   2026 valuation premium is being paid for agentic workflow platforms (n8n's re-rating,
   ServiceNow's own Action Fabric/MCP push). This roadmap pulls one small, explicitly-scoped
   agentic feature forward rather than leaving all of 3C for later.

---

## Stage 0 — Already shipped (the foundation this plan builds on)

No new work here — listed so the stages below are legible against what already exists.

| Component                                                        | Status                                | Why it matters to the cockpit                                                                      |
| ---------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Entity Engine, Workflow Engine, Automation Engine                | ✅ Done (Phase 1)                     | The FSM + outbox substrate every flagship workflow below runs on, with zero new engine code needed |
| Admin UI + Customer Portal, 7 standard modules, no-code builders | ✅ Done (Phase 2)                     | Generic entity/workflow views + workflow action buttons — the fastest path to a working demo       |
| Notifications (Novu — email, in-app, Slack-capable)              | ✅ Done (2A)                          | Already-wired notification channel; no new integration needed for Stage 1                          |
| Plugin system                                                    | ✅ Done (3B)                          | Available for later ISV/partner extension, not on the critical path here                           |
| Observability + compliance (OTel, Prometheus, GDPR, audit log)   | ✅ Done (3D)                          | Directly funds the "self-hosted = compliance-friendly, auditable" pitch                            |
| On-call/severity routing — DB + API                              | 🟡 3E Phases 1–2 merged               | The severity/escalation substrate this plan generalizes beyond on-call in Stage 3                  |
| Temporal scheduler — DB                                          | 🟡 3F Phase 1 merged                  | Underlies "stuck &gt; N hours" watchdog behavior, reusable beyond scheduling tickets               |
| Superset reporting                                               | 🔴 Spec in review (3G), nothing built | Not a Stage 1–2 dependency — see Stage 2's lighter-weight alternative                              |
| Connector runtime                                                | 🟡 3A ~40% in progress                | Only a small, named connector set is needed for the flagship workflows below                       |
| AI layer                                                         | 🔴 0%, no ADR (3C)                    | `packages/ai` is a 6-line stub — Stage 2 pulls forward one narrow slice, not all of 3C             |

---

## Stage 1 — Cockpit MVP (one flagship workflow, zero new engine code)

**Goal:** a working, demoable process — not a mockup — using only what Stage 0 already built.

| Feature                                                    | Classification | Notes                                                                                                                                                                                                            |
| ---------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vendor/procurement approval workflow, as seed config       | **Core**       | ADR-004 pure config: entity types + workflow states/transitions + SLA, no new TypeScript. Chosen over customer onboarding for Stage 1 because it has fewer departments and one clean "CFO clicks Approve" moment |
| In-app approve/reject via existing workflow action buttons | **Core**       | Reuses `getAvailableTransitions()` + the generic action-bar component (2C) — no new UI work                                                                                                                      |
| Email/in-app notification on state entry                   | **Core**       | Reuses Novu wiring (2A) — no Slack action tokens yet, see Stage 2                                                                                                                                                |
| A named, small connector list for this workflow only       | **Core**       | Slack (notify, not yet click-to-act) + one generic inbound webhook — not the full 3A connector breadth                                                                                                           |

**Explicitly deferred out of Stage 1:** Slack/email click-to-approve action tokens, any rollup
dashboard, Superset. A working demo with in-app buttons beats a polished mockup of buttons that
don't execute anything yet.

---

## Stage 2 — Cockpit differentiators (build only what pilots actually ask for)

**Goal:** the two things that turn "a workflow demo" into "a cockpit" — plus one deliberately
small agentic toehold.

| Feature                                                                                       | Classification                   | Notes                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Omni-channel action tokens (HMAC-signed approve/reject links, `POST /api/v1/actions/execute`) | **Core, demand-gated**           | This is what makes "click to act" real outside the app. Build once a pilot conversation asks for it, not speculatively                                                                                                                                                                                     |
| Lightweight rollup view (in admin-ui, over existing entity/workflow data)                     | **Core, demand-gated**           | Answer the "see everything at a glance" need with the simplest thing that works before committing to the full Superset embed                                                                                                                                                                               |
| Full Superset rollup embed (3G)                                                               | **Deferred until asked for**     | Spec already in review — pick this up only if a pilot's need outgrows the lightweight view                                                                                                                                                                                                                 |
| AI-drafted weekly digest across open processes                                                | **Core, one narrow slice of 3C** | Built on the existing `packages/ai` client. The single most CEO-legible use of AI on this roadmap — a busy executive's pain is reading the update, not authoring automation. Explicitly scoped: summarization only, no autonomous actions, consistent with ADR-012's action-scopes "human approves" spirit |

**Positioning constraint carried from the naming-collision findings:** none of this should be
badged as "the Operating System" or "AI Control Tower" — copy and UI should foreground _live
reconciliation from real systems of record_ and _enforced state transitions_, since that's the
claim monday.com/ClickUp and the EOS/BOS coaching category can't make.

---

## Stage 3 — Second flagship workflow + generalized escalation

**Goal:** prove the cockpit isn't a one-workflow trick, and stop treating 3E's escalation logic
as on-call-only.

| Feature                                                                                                 | Classification | Notes                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Customer onboarding workflow (Sales → Finance → Legal → DevOps → CS), as seed config                    | **Core**       | Add only once a paying pilot asks for a second process — richer story (5 departments) than vendor approval, but higher config effort                         |
| Generalize 3E's severity/escalation substrate beyond on-call                                            | **Core**       | The "stuck &gt; 48h → notify someone" mechanism built for on-call is exactly what should flag a stalled approval to a department head — reuse, don't rebuild |
| Finish 3E Phases 3–4 (automation actions, UI, dashboards — already in review: #597 #600 #602 #603 #605) | **Core**       | These were already coded and in PR review as of this writing — land them rather than let them stall behind new work                                          |
| Finish 3F Phases 2–4 (scheduler API, worker tick, UI — already in review: #595 #601 #604)               | **Core**       | Same — already in flight, not new scope                                                                                                                      |

---

## Stage 4 — Widen only with revenue evidence

**Goal:** everything here is explicitly gated on 1–3 paying design partners validating the
cockpit on Stages 1–3's two workflows. Do not start this stage speculatively.

| Feature                                                            | Classification                                    | Notes                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security remediation + fleet/asset-tracking scenarios              | **Important**                                     | Strong candidates precisely because 3E/3F are furthest along by this point — but they read as "an ops tool for engineering," which is why they're third/fourth, not first                                                                     |
| Full 3C AI layer (automation generation, workflow suggestion, RAG) | **Important**                                     | Needs its own ADR before implementation (per CLAUDE.md's rule that architecture decisions aren't made by inference) — only justified once pilot usage data exists                                                                             |
| Full 3A connector breadth                                          | **Important**                                     | Widen past the Stage 1 named list only once real pilots name the systems they actually need                                                                                                                                                   |
| Enterprise/Community license-gate boundary formalized              | **Important — needs co-founder + legal sign-off** | See the license discussion in the strategy artifact (BSL vs. n8n's Sustainable Use License vs. Frappe's zero-gate model) — do not default to gating SSO/RLS/audit behind Enterprise without weighing Frappe's zero-gate counter-example first |
| Full multi-tenant SSO/SCIM                                         | **Important**                                     | Table stakes once selling above the design-partner tier                                                                                                                                                                                       |

---

## What this roadmap deliberately does not decide

- Which license model to ship under (BSL / Sustainable Use / zero-gate) — a legal and board-level
  call, not an engineering default.
- The exact Enterprise-gate feature list — should be set from Stage 4's pilot usage data, not
  guessed pre-revenue.
- Whether to re-sequence 3A/3E/3F ahead of their original phase order — this roadmap assumes yes
  (per the timeline doc), but that re-sequencing itself needs the same explicit sign-off CLAUDE.md
  already reserves for starting 3C/3-OPS.
