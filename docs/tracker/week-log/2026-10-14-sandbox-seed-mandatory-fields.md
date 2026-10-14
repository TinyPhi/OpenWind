# 2026-10-14 — core-module mandatory fields; sandbox sample data actually seeds

**Session type:** Bugs found in manual testing of a new sandbox
**Spec:** `docs/specs/multi-org-sandbox.md` R4
**Branch:** `fix/sandbox-seed-mandatory-fields`

- **Rule.** In every workflow, `title` is the only required custom field. Due date, assignee,
  remark and severity are built-in ticket columns (required at the API layer), and every other
  field is optional, so the create form puts it in the Others tab.
- **What was wrong, part 1: the core modules' seed SQL** (shared by every tenant, not
  sandbox-only):
  - Deal (crm), Invoice and Leave Request (hrms) had no `title` field at all;
  - Expense Claim, Purchase Order, Invoice, Leave Request and the helpdesk ticket marked other
    fields required (amount, vendor, justification, priority, category, dates...).

  Fixed in SQL only (ADR-004): a required `title` at sort order 0 where it was missing, and
  every other field optional. Helpdesk `comment` and `article` have no workflow and are
  unchanged. Seeds use `ON CONFLICT DO NOTHING`, so existing installs (Demo Company included)
  keep their current fields; normalising those would be a separate data migration.

- **Guard.** `apps/worker/src/core-module-mandatory-fields.test.ts` reads every core module's
  seed SQL and fails if a workflow entity type lacks a required title or requires anything
  else. Before the SQL fix it failed for 6 of the 7 modules (projects was already right).
- **What was wrong, part 2: sandboxes had no sample records.** `sandbox-module-data-seed.ts`
  queried on plain `db`. On the compose `app_user` connection, RLS rejected the first
  `entity_types` lookup (`invalid input syntax for type uuid: ""`), so every module's seed failed
  and was only logged. It now runs in `withTenantContext` (as do the outbox suppression
  update, `createEntity` and `executeTransition`). CI connects as a superuser, so it never saw
  this; same class of bug as #869 and #928.
- **Seeded records now look real.** Each has:
  - a realistic per-module title (e.g. "Globex: annual platform licence");
  - a due date and a severity;
  - an assignee, round-robin over the sandbox's seeded accounts;
  - a remark;
  - a value for every other non-reference field.
- **Tests.**
  - The guard covers all 7 modules.
  - The seeder now runs in the tenant context, never on plain db.
  - Records carry title, due date, severity, assignee and remark; other fields are filled
    without touching references or `team_id`.
  - Unassigned when there are no accounts; module failure isolation; outbox suppression.
  - Provisioning passes the seeded user ids.
- **Follow-up (same PR): sandbox Reset.**
  - **Reset failed every time on compose.** Its privileged pre-step deleted
    `schedule_executions` on plain `db` (app_user), so it was refused before anything was
    wiped, and the platform admin saw a 500. It now runs those two deletes (`schedule_executions`,
    `saved_views`) in `withTenantPurgeContext`; migration 0144's role already grants exactly
    these.
  - **Reseeded records get assignees again.** Reset reads the sandbox's people from
    `org_employees.user_id` (inside the tenant context) and passes them to the seeder.
  - **Scope.** Reset still only replaces records: it never reinstalls entity types or fields,
    so a sandbox created before the field-rule fix keeps its old fields. Reset never touches
    Zitadel.
