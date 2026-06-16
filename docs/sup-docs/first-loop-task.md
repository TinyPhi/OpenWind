# Task: Track 2B — Module System + Standard Module Configs

## Goal

Build the module registry and seed runner that lets any business module be installed
by uploading a seed SQL file. Then ship all 7 standard module seeds (helpdesk, CRM,
HRMS, reimbursements, projects, invoicing, procurement) as INSERT-only SQL — zero
TypeScript in `modules/`. When done, a fresh tenant can run `pnpm db:seed --module=helpdesk`
and immediately have a working ticket workflow with SLA timers, without any code change.

## Acceptance criteria

- [ ] `module_registry` table in `packages/db` with RLS + tenant_id index + analytics annotation
- [ ] Seed runner in `packages/db/src/seed-runner.ts` that reads a module file and runs its INSERTs in a transaction
- [ ] `pnpm db:seed --module=<name>` CLI works for all 7 modules
- [ ] Helpdesk module: Ticket + Comment + Article entity types, Open→In Progress→Pending→Resolved workflow, SLA timer on ticket.created automation rule
- [ ] Reimbursements module: Expense Claim + Receipt, Draft→Submitted→Manager Review→Finance Review→Paid
- [ ] CRM module: Contact + Company + Deal + Activity, Lead→Qualified→Proposal→Won/Lost
- [ ] Projects, HRMS, Invoicing, Procurement modules: entity types + complete workflows
- [ ] Config-first test passes: zero new `.ts` files inside `modules/`
- [ ] RLS isolation tests pass for all module-seeded entity types: `pnpm test:isolation`
- [ ] All tests pass: `pnpm test`
- [ ] No lint or type errors: `pnpm typecheck && pnpm lint`

## Constraints

- Modules are seed SQL only — INSERT statements into entity_types, field_definitions, workflow_definitions, workflow_states, workflow_transitions, automation_rules
- No TypeScript in `modules/` — this is the config-first test
- Parallel approval is off-limits for pilot; use sequential approval only
- Do not touch: issue #2 (SSRF/PII gaps), parallel approval code, ADR files
- Migration for `module_registry` must follow `packages/db/migrations/` numbering
- Every new migration table needs: tenant_id NOT NULL, RLS policy, analytics annotation

## Starting point

1. Check `packages/db/migrations/` for the highest-numbered migration — new one goes next
2. Check `packages/entity-engine/src/` to understand entity_types + field_definitions schema
3. Check `packages/workflow-engine/src/` to understand workflow state/transition schema
4. Check `packages/automation-engine/src/` to understand automation_rules schema
5. Look at `.claude/prompts/new-module.md` — it has the seed SQL template for a module
6. Look at `.claude/prompts/new-migration.md` — it has the migration checklist
