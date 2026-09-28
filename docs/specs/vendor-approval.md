# Vendor Approval Module (3H Phase 1)

> Config-only module (seed SQL, no TS in `modules/`) for a sequential, multi-department vendor
> approval chain: Draft → IT Security Review → Legal Review → Pending Final Approval →
> Approved / Rejected. The Cockpit MVP flagship demo (issue #606, tracker #613).

status: implemented (T12 live walk-through risk-accepted, tracked in #691 — see §B)
created: 2026-09-27
updated: 2026-09-27

---

## §G Goal

A working, demoable cross-functional approval workflow — not a mockup — built entirely as seed
config on the Phase 1 engines. Each review stage is gated by a real department role, so the
demo shows "IT Security approves, then Legal approves, then Finance approves," not three
clicks by the same admin.

## §C Constraints

| constraint       | value                                                                                                                                                                                                                                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack            | Entity Engine + Workflow Engine + Automation Engine; module = SQL only (ADR-004)                                                                                                                                                                                                                                                               |
| module category  | `@modules/vendor-approval`, `category: "optional"` (ADR-005, same shape as `tender`) — never auto-installed                                                                                                                                                                                                                                    |
| seed layout      | mirror `modules/tender/seed/`: `001_entity_types.sql`, `002_workflow.sql`, `003_automation_rules.sql`, `004_view_configs.sql`; idempotent on `(tenant_id, entity type name)`                                                                                                                                                                   |
| approval shape   | sequential only; parallel/quorum approval (ADR-002, #65) out of scope and off-limits                                                                                                                                                                                                                                                           |
| roles            | three new Zitadel **project** roles: `it_security`, `legal`, `finance_approver`. Roles flow unfiltered from the JWT claim (`packages/auth/src/jwks.ts:291`) into `allowed_roles` (free `text[]`) — no engine/auth change needed. Zitadel project roles are platform-wide, not per-tenant: every tenant's role picker will list them. Accepted. |
| base role        | entity routes require `admin`/`agent`/`user` (`execute-transition.ts:20`, `create.ts:97`), and admin-ui treats non-`admin`/`agent` users as customers — so department approvers hold `agent` **plus** their department role. A department role alone is not sufficient and is not a supported configuration.                                   |
| admin override   | every review transition's `allowed_roles` also includes `admin` (operational escape hatch; same as every other module)                                                                                                                                                                                                                         |
| SLA              | 48h on each of the three review states; no SLA on Draft or terminal states                                                                                                                                                                                                                                                                     |
| notify recipient | `NotifyConfig` needs a fixed `recipientId` (`packages/automation-engine/src/actions/notify.ts:127`) — no role- or assignee-based recipient exists. See §D1.                                                                                                                                                                                    |
| external source  | synthetic payload only (critical-path-decisions 1a = A, 2 = A: bypass webhook gateway). Real source is #634 — out of scope                                                                                                                                                                                                                     |
| demo tenant      | none exists; demo runs on the dev tenant (`DEV_TENANT_ID`) via scripts, not module seed SQL (module seed must stay tenant-agnostic and data-free)                                                                                                                                                                                              |
| out of scope     | action tokens (#607), rollup view (#608), digest (#609), Superset (3G), per-instance `__accessUsers` guard gap (ADR-006 accepted v1 limitation), WhatsApp/Tally/greytHR sources (#634)                                                                                                                                                         |

## §D Decisions

**D1 — notification recipients (recommended: config placeholders, no engine change).** Module seed
ships one `notify` rule per review-state entry, `is_enabled = false`, `recipientId` unset, named so
the tenant admin can find and complete them in the existing automation builder. The demo setup
script fills in the dev-tenant approver user IDs and enables them. Rationale: keeps #606 pure config
(its core constraint), and a role-/assignee-targeted notify is an automation-engine contract
change that #607 (action tokens) will need anyway — better designed there than bolted on here.
Alternative, not chosen: add `recipientRole`/`recipientField` to `NotifyConfig` in this PR.

**D2 — swappable external entry point (keeps #634 cheap).** The synthetic "external vendor"
arrives as a JSON fixture matching a documented payload shape (`§I Payload`). It is Zod-validated
by `VendorPayloadSchema` and mapped by `mapVendorPayload`
(`apps/api/src/scripts/vendor-approval-payload.ts`). The demo script then calls the entity
engine's `createEntity`, the same function `POST /entities` calls. Records carry `source_system` +
`external_ref` fields. Swapping to a real source (#634) replaces only the caller of the mapping
(for example, a connector trigger-transform); entity type, workflow, and rules stay unchanged.
The script lives in `apps/api/src/scripts/`, not root `scripts/`, because the backend image
copies `apps/api/` but not `scripts/`, and `apps/api`'s typecheck/lint only cover `src/`.

## §I Interfaces

**Entity type:** `vendor` (plural `Vendors`, icon `building`) — fields:

| field                  | type     | required at create | required by transition                       |
| ---------------------- | -------- | ------------------ | -------------------------------------------- |
| vendor_name            | text     | yes                | —                                            |
| contact_email          | text     | no                 | draft → it_security_review                   |
| category               | select   | yes                | — (software, services, hardware, consulting) |
| annual_spend_estimate  | currency | no                 | draft → it_security_review                   |
| business_justification | longtext | no                 | draft → it_security_review                   |
| security_questionnaire | file     | no                 | draft → it_security_review                   |
| contract_draft         | file     | no                 | legal_review → pending_final_approval        |
| source_system          | text     | no                 | — (`manual` default in UI; `synthetic-demo`) |
| external_ref           | text     | no                 | —                                            |

**Workflow `vendor` (terminal \*):**

```
draft                  → it_security_review      [agent, admin]             requires_fields per table
it_security_review     → legal_review            [it_security, admin]
it_security_review     → rejected*               [it_security, admin]       requires_comment
legal_review           → pending_final_approval  [legal, admin]             requires contract_draft
legal_review           → rejected*               [legal, admin]             requires_comment
pending_final_approval → approved*               [finance_approver, admin]
pending_final_approval → rejected*               [finance_approver, admin]  requires_comment
```

SLA 48h on `it_security_review`, `legal_review`, `pending_final_approval`.

**Automation rules:** three `workflow.transitioned` rules, `trigger_config={"entityType":"vendor"}`
(informational only; see §B B1), condition `entityTypeId eq <tenant's vendor type id> AND toState
eq <review state>`, action `notify` (see D1), `is_enabled=false` in seed.

**View configs:** `entity_type_slug='vendor'` — list: vendor_name, category, currentState,
annual_spend_estimate, createdAt; detail groups: Vendor, Justification & Spend, Security,
Legal, Source.

**Payload (synthetic external vendor, D2):**

```json
{
  "source": "synthetic-demo",
  "externalId": "string",
  "vendor": {
    "name": "string",
    "email": "string",
    "category": "software|services|hardware|consulting",
    "annualSpend": 0,
    "currency": "INR",
    "justification": "string"
  }
}
```

## §R Requirements

- R1: `vendor-approval` registered in `seedRegistry()` as `optional`; installing it on a tenant
  creates the entity type, fields, workflow, states, transitions, rules, view config; re-install
  is a no-op (idempotent); never auto-installed by `provisionTenant`.
- R2: Each review transition is executable only by its department role or `admin`; an `agent`
  without the department role gets `TRANSITION_FORBIDDEN`; `getAvailableTransitions` hides it.
- R3: Required fields / comments enforced per §I.
- R4: Three notify rules exist per install (disabled, per D1); when enabled with a recipient, a
  notification is created on entry to each review state.
- R5: Record renders in existing admin-ui list/detail views with the action bar (no new frontend code).
- R6: Dev bootstrap creates the three project roles and three demo approver users
  (`agent` + department role); `modules/vendor-approval/README.md` documents the one-time
  server-side role creation.
- R7: Demo script: installs module on dev tenant, fills + enables notify rules, creates demo
  vendors at varied states from fixtures via the D2 mapping; idempotent re-run.
- R8: Tenant isolation holds for all seeded rows (isolation test).
- R9: Docs: module README (setup + demo runbook); tracker/week-log. #606 ACs + #613 checkbox
  ticked once merged.

## §V Invariants

- V1: zero TypeScript in `modules/vendor-approval/` beyond the one-line stub `src/index.ts`.
- V2: no demo/tenant data in module seed SQL — demo data lives only in scripts.
- V3: no role list hardcoded in engine/auth code for this module; roles appear only in seed SQL
  `allowed_roles` and dev bootstrap.

## §T Tasks

| id  | task                                                                                                 | req        | status          |
| --- | ---------------------------------------------------------------------------------------------------- | ---------- | --------------- |
| T1  | `modules/vendor-approval` package scaffold (package.json, tsconfig, stub index.ts, README)           | R1, V1     | done            |
| T2  | `001_entity_types.sql` — vendor entity + fields                                                      | R1, R3     | done            |
| T3  | `002_workflow.sql` — states, SLA, role-guarded transitions                                           | R1, R2, R3 | done            |
| T4  | `003_automation_rules.sql` — 3 disabled notify rules                                                 | R4         | done            |
| T5  | `004_view_configs.sql`                                                                               | R5         | done            |
| T6  | `seedRegistry()` entry (`seed-demo.ts` doesn't list optional modules — no entry needed)              | R1         | done            |
| T7  | Integration test: install creates rows, idempotent, not auto-installed; role guards (R2/R3)          | R1–R3      | done            |
| T8  | Isolation test: seeded rows invisible cross-tenant                                                   | R8         | done            |
| T9  | Automation test: enabled rule on transition → notification row                                       | R4         | done            |
| T10 | `scripts/bootstrap.ts` — 3 roles + 3 demo approver users                                             | R6         | done            |
| T11 | `scripts/vendor-approval-demo.ts` + fixtures — install, wire notify, create demo vendors via mapping | R7, D2     | done            |
| T12 | Manual E2E in docker stack: Draft → Approved across 3 role users; screenshot/notes                   | R5, R7     | deferred (#691) |
| T13 | Module README (setup + runbook); tracker row, week-log; issue checkboxes after merge                 | R6, R9     | done            |

## §B Bugs / Backprop Log

- **B1 (found during T9, 2026-09-27):** the automation executor never reads `trigger_config`.
  Rules match on `trigger_type` + conditions only (`packages/automation-engine/src/executor.ts`),
  so a bare `toState eq legal_review` condition fires for every entity type in the tenant that
  has a `legal_review` state. Fixed here in config by pinning `entityTypeId` in each rule's
  condition. The regression test fires the same `toState` for a different entity type and
  asserts no notification. The platform-level gap, which also affects tender, is filed in
  `docs/reviews/pending-review-findings.md`.
- **B2 (found during T2, 2026-09-27):** `textarea` is not a registered field type (the multi-line
  type is `longtext`). Unknown types fall through to `z.unknown()` in the schema builder, silently
  skipping validation. This module uses `longtext`. Tender's four `textarea` fields have the same
  latent bug; filed in `pending-review-findings.md`.
- **B7 (PR review N2) — rejected fixtures could end approved.** A vendor resumed past
  `it_security_review` with `advanceTo: "rejected"` walked the approval path to Approved (the
  terminal-state check stopped the loop, so it never looped indefinitely). The script now rejects
  at `rejectAt`, or at the current review stage if the vendor is already past it, using that
  stage's department role. Fixtures gain an optional `rejectAt`, and demo-vendor-007 is rejected
  at Legal. The decision lives in `apps/api/src/scripts/vendor-approval-rejection.ts` (unit-tested). Verified on a throwaway tenant, including resuming at Legal and at Final Approval. The script also calls
  `seedRegistry()` first, so it works before the API has ever booted.
- **Risk accepted — T12 (and a live T10 bootstrap run) deferred to #691.** Accepted by
  @abmish on 2026-09-27 as an explicit team decision, so the PR can merge without the live
  walk-through.
  - **Not verified live:** Zitadel putting the department roles in the JWT claim; admin-ui
    showing or hiding the action bar per role; `ow-worker` consuming the 48h
    `workflow.sla_scheduled` events; `pnpm bootstrap` running clean with the new roles and users.
  - **Why the risk is bounded:**
    - The module is `category: optional`, so no tenant has it until an admin installs it.
    - Role gating is enforced server-side by the workflow engine. A UI gating defect would show
      buttons that return `TRANSITION_FORBIDDEN`; it would not grant access.
    - SLA scheduling is proven at the outbox level by an integration test.
  - **Covered meanwhile:** the engine-level walk-through, role guards, required fields,
    rejection at every stage and SLA scheduling (integration tests); tenant isolation; and the
    demo script against throwaway tenants.
  - **To close:** run the #691 checklist and record "T12 PASS" with the date here, or file bugs.
