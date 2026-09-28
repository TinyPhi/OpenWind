# ADR-020: Module Ownership Model — Coordination-Native Modules vs. Domain-Deep Verticals

**Status:** Draft for peer review (drafted 2026-09-28; direction confirmed 2026-09-18 in #622).  
**Date:** 2026-09-28.  
**Deciders:** Engineering Lead (acceptance pending).  
**Related to:** ADR-004 (config-first module design), ADR-005 (core vs. optional modules),
ADR-009 (connector runtime / webhook gateway), ADR-016 (on-call routing), ADR-017 (temporal
scheduler), issue #622 (direction), #606 / #680 (first case), #613 (3H tracker), #673 (module
upgrade workflow), #695 (ADR backlog).  
**Supersedes:** —  
**Superseded by:** —

---

## Context

### Problem — No rule for which modules the platform owns, or how deep they go

The repository ships nine modules under `modules/`, each seed SQL plus a one-line stub
`src/index.ts` (ADR-004). `ModuleService.seedRegistry()` in
`apps/api/src/services/module-service.ts` registers seven as `category: "core"` (helpdesk, crm,
hrms, reimbursements, projects, invoicing, procurement) and two as `category: "optional"` (tender,
vendor-approval). ADR-005 introduced the `core`/`optional` split, but it answers only "does this
module auto-install on tenant creation?" It says nothing about:

- which kinds of module the platform should build and maintain as first-party product;
- how deep a module may grow (a thin approval workflow vs. a full departmental system with
  master data and sub-processes);
- when a new capability belongs in an existing module vs. a new one.

Without that rule, every module proposal is judged ad hoc. Two failure modes are both live
(#622): speculative depth investment in single-department modules that no current tenant has
asked for, and the opposite correction, freezing modules that serve a real tenant in production.

### How this came up

#622 opened on 2026-09-18 as a narrow proposal to reclassify `procurement` from `core` to
`optional`. It broadened the same day into the question of what the platform should own. The
direction recorded there, which the project owner confirmed on 2026-09-18, splits modules
along a different axis from `core`/`optional`:

- **Coordination-native modules**: route an action or decision between people and roles across
  departments. Own these outright.
- **Domain-deep verticals**: model one department's specialized data and sub-processes. Build them
  bespoke when a customer asks, not speculatively. Do not freeze them either.

The owner refined an initial "freeze CRM/HRMS/procurement investment" recommendation into
"demand-gated bespoke builds" (#622, _idea-refine outcome_). The existing CRM/HRMS/procurement
modules were built for a pilot customer's actual needs, not as speculative platform bets.

### The first concrete case — vendor approval (#606, merged in #680)

3H Phase 1 (#606) needed a sequential cross-department approval chain: Draft → IT Security
Review → Legal Review → Pending Final Approval → Approved / Rejected. Each stage is gated by a
department role (`it_security`, `legal`, `finance_approver`) and carries a 48h review SLA
(`docs/specs/vendor-approval.md` §C). The obvious alternative was to extend `modules/procurement`.
Its seed already has a Purchase Order workflow (Requested → Under Review → Approved → Ordered →
Received / Rejected, single `admin` approver; `modules/procurement/seed/001_seed.sql:35-50`).
But it has no `vendor` entity type. `vendor` is a plain `text` field on Purchase Order (`:14`),
even though the stub comment in `modules/procurement/src/index.ts` lists "Vendor, RFQ".

On 2026-09-18 the #606 decision thread chose "a new, small module (not bolted onto
`modules/procurement`)". #680 merged it on 2026-09-28 as `@modules/vendor-approval`,
`category: "optional"`, config only (`modules/vendor-approval/seed/001–004`). This ADR
generalizes that precedent.

### What already exists that this ADR builds on

- ADR-004: modules are configuration, and anything config cannot express becomes an engine
  primitive, never module code (Decision item 6).
- ADR-009: the connector runtime and webhook gateway, the integration path for records whose
  source of truth lives outside the platform.
- ADR-016 / ADR-017: on-call routing and the temporal scheduler. These are coordination
  capabilities delivered as packages (`packages/teams`, `packages/scheduler`) rather than modules,
  which makes them precedent for treating coordination as the platform's own concern.
- Open issue #673: no mechanism exists yet to apply new seed rows to tenants that already have a
  module installed.

---

## Decision

### Decision 1 — Classification criterion: coordination-native vs. domain-deep

A module is **coordination-native** when all of these hold:

1. Its main job is moving a record between roles or departments: approval, review, handoff,
   escalation, acknowledgement.
2. Its data model is thin. It holds the record being coordinated and the fields the decision
   needs, not a department's master data or sub-ledgers.
3. It is fully expressible in the three engines (entity types, workflow states/transitions with
   role guards and SLAs, automation rules) with no engine change specific to one tenant.
4. It still works when the underlying record comes from an external system through ADR-009
   (for example `source_system` / `external_ref` on `vendor`; `docs/specs/vendor-approval.md` §D2).

A module is a **domain-deep vertical** when its value lies mainly in one department's
specialized data and processes, such as master data, catalogues, multi-entity sub-processes
(RFQs, payroll, pipelines) or department-specific reporting, i.e. the scope of a dedicated
single-department system.

The class is recorded in this ADR's catalogue (below), not in schema. It is independent of
ADR-005's `category`. `category` controls auto-install; class controls ownership and investment.

**Provisional catalogue.** #622 names only the helpdesk/approvals side and CRM/HRMS/procurement
explicitly; rows marked _proposed_ come from applying the criteria to each module's seed. Humans must
confirm every row at acceptance (OQ-1, OQ-2).

| Module            | `category` (today) | Proposed class                        |
| ----------------- | ------------------ | ------------------------------------- |
| `helpdesk`        | core               | Coordination-native                   |
| `vendor-approval` | optional           | Coordination-native                   |
| `reimbursements`  | core               | Coordination-native (proposed, OQ-1)  |
| `crm`             | core               | Domain-deep vertical (bespoke)        |
| `hrms`            | core               | Domain-deep vertical (bespoke)        |
| `procurement`     | core               | Domain-deep vertical (bespoke)        |
| `invoicing`       | core               | Domain-deep vertical (proposed, OQ-2) |
| `projects`        | core               | Domain-deep vertical (proposed, OQ-1) |
| `tender`          | optional           | Domain-deep vertical (proposed, OQ-2) |

**Boundary rule (proposed).** The four coordination-native criteria are conjunctive, so a module
that fails any one of them is treated as domain-deep for ownership purposes. It is then maintained
on demand, not owned outright. Applying the criteria to each seed:

- `reimbursements` meets 1–3. One thin `Expense Claim` type with six fields and no master data.
  Its workflow hands the record across roles: `user` submits, only `admin` approves, rejects
  (comment required) or marks paid (`modules/reimbursements/seed/001_seed.sql`). Criterion 4 holds
  because claims can originate in an external expense tool.
- `projects` fails 1. Every one of its eight `Task` transitions is `admin`/`agent`, with no
  handoff to another role and no SLA. `story_points` and a backlog/review pipeline make it one
  team's work tracker (`modules/projects/seed/001_seed.sql`).
- `invoicing` fails 1. Every transition is `admin`/`agent` and there is no approval step. The
  `Invoice` lifecycle (sent → viewed → paid/overdue) is the finance team's receivables record, and
  deepening it means line items, tax and payment ledgers, which are sub-ledgers
  (`modules/invoicing/seed/001_seed.sql`).
- `tender` fails 1 and 2. Its seven-state bid-preparation pipeline is `agent`/`admin` throughout.
  It carries specialised bid data (BOQ file, eligibility, certifications, `financial`-tagged
  finance details) and a multi-entity sub-process: a costing child ticket spawned by a
  `create_child` rule (`modules/tender/seed/001–003`). ADR-005 plans a further issuing side.

### Decision 2 — Ownership consequence of each class

- **Coordination-native modules are owned outright by the platform.** Their seed config is
  first-party product. The platform team maintains it, reviews it with the same rigor as engine
  code, and evolves it without a specific customer request. Roadmap work under 3H (#607–#612)
  targets this class.
- **Domain-deep verticals are maintained as customer-driven configuration.** Seed changes happen
  in response to a concrete customer requirement. A proposal to deepen one is checked against
  "which real customer needs this," not accepted as general platform investment.
- **The upgrade path is the same for both classes and remains open.** Seed files are idempotent
  on first install, but nothing propagates new seed rows to already-installed tenants (#673).
  Some seeds reset tenant-editable config when re-run. For example, `procurement` deletes and
  re-inserts its workflow states and transitions (`modules/procurement/seed/001_seed.sql:31-33`).
  Until #673 lands, any seed change to an installed module must ship with an explicit backfill
  note in its PR (proposed PR-template line, OQ-4). This ADR does not choose the #673 mechanism.

### Decision 3 — New flagship workflows ship as separate `optional` modules

A new coordination-native workflow ships as a **new module with `category: "optional"`**. It does
not extend an existing module that was built for a specific customer's domain, even when the two
share a noun (vendor, purchase order). Reasons:

- **Blast radius.** Every `core` module auto-installs on every new tenant (ADR-005). Extending one
  changes what all future tenants receive by default and, once #673 exists, possibly what existing
  tenants receive as well. A separate `optional` module affects only the tenants that install it.
- **Seed safety.** Re-running an existing module's seed to add states can overwrite tenant
  workflow edits (Decision 2). A new module has no installed base to overwrite.
- **Shape mismatch.** Vendor approval needed a first-class `vendor` entity, three department
  roles and per-stage SLAs. The Purchase Order workflow has none of these, so extending it would
  likely have required reshaping a live production workflow rather than only adding config.
- **Precedent.** ADR-005 already ratified `tender` as a standalone optional module "not folded
  into `@modules/procurement`". #680 follows the same shape.

Promoting a coordination-native module from `optional` to `core` is a separate ADR-005
amendment, not decided here (Deferred).

### Decision 4 — Domain-deep verticals: built on a concrete ask, config-first, engine-last

A domain-deep vertical, or a deepening of an existing one, is built only against a **concrete,
named requirement from a tenant** (proposed definition in OQ-3). It is neither frozen nor speculative. When one is built:

1. It is seed configuration per ADR-004. There is no TypeScript in `modules/`, no module routes
   and no module tables.
2. The ADR-004 script action and plugin escape hatches apply unchanged.
3. An engine primitive is added only when config genuinely cannot express the need. It follows
   ADR-004 Decision item 6 (engine PR, tests, ADR entry) and must be generic across tenants. An
   engine feature that only one vertical can ever use is a signal to reconsider the plugin path.
4. Where the customer already runs a dedicated system for that domain, prefer an ADR-009
   connector feeding a coordination-native module over rebuilding that system as seed config.

### Decision 5 — Existing bespoke modules remain production configuration

`crm`, `hrms` and `procurement` were built for a pilot customer's actual requirements (#622);
whether `invoicing` and `tender` share that origin is OQ-2. They are **real production configuration, not a sandbox or a reference sample.**
Concretely:

- They are not deprecated, frozen, migrated or reclassified by this ADR. Their `category` stays
  as `seedRegistry()` has it today.
- Changes follow normal review, test and isolation rules and the #673 caveat (Decision 2); they
  are not an experimentation area for coordination-native features (Decision 3).
- Whether any of them should eventually become connector-backed rather than native is deferred.

---

## Consequences

### Positive

- Module proposals get a stated test (Decision 1) instead of ad hoc judgment.
- Coordination-native work concentrates on what the three engines express natively. That
  reinforces ADR-004 rather than straining it.
- New flagship workflows ship with zero impact on tenants that do not install them.
- Existing bespoke modules keep a clear maintenance contract instead of an ambiguous "frozen"
  status.

### Negative and mitigations

- **Duplicate nouns across modules** (`vendor` in vendor-approval; a `vendor` text field on
  Purchase Order). Mitigation: acceptable while the modules serve different workflows. Unifying
  them is deferred until a tenant installs both and needs linkage, which would use the
  entity-engine relations API, not cross-module imports.
- **Classification is a judgment call** at the boundary (`projects`, `reimbursements`).
  Mitigation: the catalogue is ADR-owned and each row is confirmed by a human; the proposed
  boundary rule (Decision 1) resolves ties, and OQ-1/OQ-2 track the proposed rows.
- **The upgrade gap (#673) affects owned modules most**, because they evolve without a customer
  trigger. Mitigation: the Decision 2 backfill note until #673 lands, and #673 prioritized
  alongside 3H Phase 2+.
- **"Demand-gated" can drift into unbounded per-customer work.** Mitigation: Decision 4 keeps
  every build config-first and requires any engine addition to be generic across tenants.

---

## Deferred Decisions

| Deferred item                                                            | Trigger to revisit                                                             | Why deferred                                                         |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Reclassify `procurement` (or `crm`/`hrms`) from `core` to `optional`     | Human decision on #622's narrow proposal; needs ADR-005 amendment              | `category` is orthogonal to class; changing it affects new tenants   |
| Promote `vendor-approval` (or later flagships) to `core`                 | Usage evidence from 3H Phase 4 (#612)                                          | Auto-install for all tenants needs evidence it is universally wanted |
| Connector-backed replacement of a native domain-deep vertical            | Flagship external-source work (#634) ships, or a tenant asks for it concretely | Depends on real usage data; no current requirement                   |
| Linking duplicate entities across modules (e.g. vendor ↔ Purchase Order) | A tenant installs both modules and needs cross-references                      | No current tenant requirement; relations API already exists          |
| Module upgrade mechanism for installed tenants                           | #673                                                                           | Separate engineering decision; affects all modules equally           |
| Recording class in schema (e.g. a `modules.ownership` column)            | Tooling or UI needs to branch on class                                         | Documentation-only classification is sufficient today                |

---

## Open Questions

| ID   | Question                                                                                                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OQ-1 | Is each catalogue row in Decision 1 correct, especially `projects` (undecided) and `reimbursements` (coordination-native)? | **Proposed:** `reimbursements` is coordination-native and `projects` is domain-deep, under the boundary rule. Why: the seeds meet or fail criterion 1 as shown under the catalogue, and #622 names neither module. Needs human confirmation of both rows and of the boundary rule itself.                                                                                                                                                                                                                                                        |
| OQ-2 | Are `invoicing` and `tender` domain-deep, and were they built for the same pilot requirements as CRM/HRMS/procurement?     | **Proposed (class):** both are domain-deep. Both fail criterion 1, and `tender` also fails 2. Needs human confirmation. **Still open (origin):** git history cannot answer it, because the earliest commit touching either module here is the docs commit `9192d9e` (2026-08-07). The project owner's statement on #622 closes it. It changes only Decision 5's wording, not the class.                                                                                                                                                          |
| OQ-3 | What counts as a "concrete ask" for Decision 4: a signed tenant, a named requirement, or an internal sponsor?              | **Proposed:** a concrete ask is a GitHub issue that (a) identifies an existing or contracted tenant as the requester (an internal reference is fine where the name is confidential), (b) states the requirement as acceptance criteria and (c) was confirmed by the project owner. An internal sponsor alone, or a hypothetical future tenant, does not qualify. Why: it can be checked at review time and leaves an audit trail on the issue, and it matches #622's "a real customer asks". Needs human confirmation.                           |
| OQ-4 | Should the Decision 2 backfill note become a PR-template or guardrail check until #673 lands?                              | **Proposed:** yes, as a PR-template line only. Add an "If this PR touches `modules/*/seed/`" block to `.github/pull_request_template.md` asking how installed tenants receive the change (or "new installs only") and whether re-running the seed resets tenant-edited states or transitions (#673). The template is not a workflow file, so it is in scope. A CI guardrail in `scripts/check-contribution-guardrails.sh` runs from a human-owned workflow and is left to a human. Follow-up PR, not part of this ADR. Needs human confirmation. |

---

## Implementation status

- #680 (merged 2026-09-28) is the first application of Decisions 1 and 3: `@modules/vendor-approval`,
  `category: "optional"`, config only. Its live walk-through is still open (#691).
- There are no code or schema changes for this ADR itself. `seedRegistry()` categories are
  unchanged. The #622 acceptance item "module-service.ts category updates (if any)" resolves to
  "none" unless a Deferred reclassification is later accepted.
- On acceptance: tick #622's ADR criterion, update the 3H row in
  `docs/tracker/roadmap-tracker.md` to cite ADR-020, and add the ADR to CLAUDE.md's "Read before
  touching" table for `modules/`.
