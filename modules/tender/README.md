# Tender Management Module

Config-only module (seed SQL, zero TypeScript) for the tender team's lifecycle:
`draft → boq_preparation → pending_costing_review → costing_approved → document_preparation → pending_submission_review → submitted`.

Costing review is handled as an isolated **child ticket** (existing parent-child
mechanism, unmodified) so the costing team never sees the parent tender's
client/financial fields.

Source spec: `docs/specs/tender-management.md`.

## Required setup before install

- None — this module uses only the platform's existing global roles (`agent`,
  `admin`, sourced from Zitadel claims). There is no `tender_owner` or
  `costing_lead` role anywhere in this platform (verified against
  `packages/auth`) — an earlier draft of this module wrongly assumed those
  roles existed and gated every transition on them, which would have meant
  **no user could ever transition a tender**. Fixed: all transitions now use
  `allowed_roles: [agent, admin]`.
- "Tender owner" is not a role — it's whichever agent is `assignedTo` the
  tender, same convention as any other ticket.
- Costing isolation does not need a role either — the costing analyst is
  isolated by being `assignedTo` the child ticket (see Automation rules),
  regardless of whether they hold the `agent` role or no role at all.
- See "Resolved — #162" below — the automation rule in `003_automation_rules.sql`
  now ships enabled; the child ticket it creates starts unassigned pending a
  follow-up (no default-assignee config exists yet).

## Entity type

`tender` (see `001_entity_types.sql`):

| field                  | type       | sensitivity | notes                                                                                      |
| ---------------------- | ---------- | ----------- | ------------------------------------------------------------------------------------------ |
| `title`                | text       | internal    | required, indexed                                                                          |
| `client_name`          | text       | internal    | required, indexed                                                                          |
| `summary`              | textarea   | internal    | required by draft → boq_preparation                                                        |
| `finance_details`      | textarea   | financial   | required by draft → boq_preparation; redacted in events                                    |
| `eligibility_criteria` | textarea   | internal    | required by draft → boq_preparation                                                        |
| `certifications`       | textarea   | internal    | required by draft → boq_preparation                                                        |
| `boq_file`             | file       | internal    | required by boq_preparation → pending_costing_review                                       |
| `costing_child_id`     | entity_ref | internal    | self-referencing; written by automation on first entry to pending_costing_review (see gap) |
| `tender_documents`     | file       | internal    | required by document_preparation → pending_submission_review                               |
| `submitted_at`         | datetime   | internal    | written by workflow engine on transition to `submitted`                                    |
| `submitted_by`         | user_ref   | internal    | written by workflow engine on transition to `submitted`                                    |

`field_type` values used (`text`, `textarea`, `file`, `entity_ref`, `datetime`, `user_ref`)
follow the naming convention already used elsewhere in the codebase (`entity_ref`/`user_ref`
appear in `modules/helpdesk` and `.claude/context/parallel-approval-pattern.md`; `date` is
used by several modules for date-only fields). There is no DB-enforced enum on `field_type`
(it's a plain `text` column — see `packages/db/src/schema/entity-engine.ts`), so `file` and
`datetime` are new-but-consistent names, not values pulled from an existing constraint.

## Workflow — `tender_workflow`

States (`submitted` is terminal, no outgoing transitions): `draft`, `boq_preparation`,
`pending_costing_review`, `costing_approved`, `document_preparation`,
`pending_submission_review`, `submitted`.

Transitions (see `002_workflow.sql`):

| from                      | to                            | roles        | requires_fields                                                | requires_comment |
| ------------------------- | ----------------------------- | ------------ | -------------------------------------------------------------- | ---------------- |
| draft                     | boq_preparation               | agent, admin | summary, finance_details, eligibility_criteria, certifications | no               |
| boq_preparation           | pending_costing_review        | agent, admin | boq_file                                                       | no               |
| pending_costing_review    | costing_approved              | agent, admin | —                                                              | yes              |
| pending_costing_review    | boq_preparation (reject)      | agent, admin | —                                                              | yes              |
| costing_approved          | document_preparation          | agent, admin | —                                                              | no               |
| document_preparation      | pending_submission_review     | agent, admin | tender_documents                                               | no               |
| pending_submission_review | submitted (terminal)          | agent, admin | —                                                              | no               |
| pending_submission_review | document_preparation (reject) | agent, admin | —                                                              | yes              |

Note: `allowed_roles` checks the actor's global roles only — the platform's
workflow engine (`packages/workflow-engine/src/engine.ts::executeTransition`)
does not currently consult per-instance access grants (`__accessUsers`) when
gating transitions. So any `agent`/`admin`, not just the tender's assignee,
can transition any tender. Narrowing that further would require an engine
change and is out of scope here.

## Automation rules

`003_automation_rules.sql` defines one rule: on `workflow.transitioned` into
`pending_costing_review` where `costing_child_id` is not already set, create a
costing child ticket (assigned to a specific user — no role lookup, since no
`costing_lead` role exists — description seeded from `title` + `summary`
only) and write the resulting child id back onto `costing_child_id`.

### Resolved — #162

The automation-engine action executor (`packages/automation-engine/src/executor.ts`)
now dispatches a `create_child` action type
(`packages/automation-engine/src/actions/create-child.ts`), which calls
`createChildRelation()` in `packages/entity-engine/src/child-relations.ts` (the
existing parent-child mechanism, unmodified) and then writes the new child's id
back onto the field named by `writeBackField` (here, `costing_child_id`).

`003_automation_rules.sql`'s rule is now seeded with `is_enabled = true`.

**Remaining follow-up (not a blocker):** `assignToUserId` is seeded `null` — there
is still no per-tenant default-assignee configuration to resolve a real user from,
and no `costing_lead` role exists to look up instead (see ROLE NOTE in the seed
file). The created child ticket is therefore unassigned until an agent manually
assigns it; the field/data isolation (parent's `client_name`/`finance_details` are
never copied to the child) holds regardless, but the "costing analyst never sees
the parent ticket" guarantee via assignment scoping only takes effect once
assigned.

## View config

`004_view_configs.sql` sets list columns (title, client, status, submitted_at,
created_at), a grouped detail layout (Overview / Financial & Eligibility / BOQ &
Costing / Documents & Submission), and the create-form field order.

## Module registration

Modules are **not** registered via SQL in this codebase. `apps/api/src/services/module-service.ts`
(`ModuleService.seedRegistry()`) hardcodes a `standardModules` array (slug, name,
description, version, isSystem, minPlan) and upserts it into the `modules` table on
first API boot / registry-empty. A `tender` entry has been added to that array (see
diff in `apps/api/src/services/module-service.ts`) following the exact shape used
for `helpdesk`, `crm`, etc. Install/uninstall then works through the existing
`ModuleService.installModule()` / `uninstallModule()` flow, which reads
`modules/tender/seed/*.sql` off disk and runs it inside `withTenantContext` —
no further wiring needed beyond that array entry.

## Out of scope (per spec §C)

BOQ line-item entity (BOQ is a single file attachment), post-submission outcome
states (awarded/lost/withdrawn), submission-proof file requirement, quorum/multi-approver
costing review, and the platform-level RLS fix (issue #121, tracked separately).
