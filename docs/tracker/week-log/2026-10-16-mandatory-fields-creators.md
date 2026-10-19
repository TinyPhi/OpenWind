# 2026-10-16 — mandatory ticket fields, PR 2.2 (automations, scheduler, seeder, workflow owner)

**Session type:** Owner-requested follow-up to PR #973
**Branch:** `feat/mandatory-fields-creators` (stacked on #973)
**Spec:** [mandatory-ticket-fields](../../specs/mandatory-ticket-fields.md) (R4 remaining
creators, R7 defaults; T6 part 2, T8 part 1)

- **Owner decisions (interview).**
  - **No owner on a workflow:** fall back, at run time, to the tenant's longest-standing admin.
    No migration.
  - **Automation title default:** the rule's name; a sub-task gets `<rule name>: <parent title>`.
  - **Scheduler due date:** counted from the ticket's creation, not the scheduled fire time.
- **What changed.**
  - **Fallback assignee** (`apps/worker/src/fallback-assignee.ts`).
    - Order: the workflow's creator, then its workflow admins (each only while a current tenant
      member, never an erased id), then the Zitadel admin of the tenant's org who joined the
      tenant first.
    - The automation engine can't call Zitadel, so the worker registers it at startup, the same
      pattern as the audit hook.
  - **Automation `create_entity` / `create_child`** take an optional template (title, due days,
    remark, severity, assignee or team) and always create all five values.
    - Missing values get the defaults: due in 3 days, medium, "Created by automation: <rule>",
      the default title, the fallback assignee.
    - With nobody to assign, the execution fails as `NO_ASSIGNEE`; no unassigned ticket.
    - The older single-assignee settings keep working.
    - Only tickets (a type with an active workflow, the tenant's own before a global
      template) get the defaults. Other record types are created as before.
    - A rule's template is now accepted and validated by the automation-rule API; before,
      zod silently dropped it. An unusable `due_days` from seed SQL falls back to 3 days.
    - `NO_ASSIGNEE` doesn't count as a circuit-breaker failure, so one misconfigured rule
      can't switch off the tenant's correct ones. Its logged message says what to fix.
  - **Scheduler.**
    - Due date = creation + `due_days`, so a late catch-up run no longer creates a ticket
      already past due (which the engine rejected).
    - Severity (default medium) and the remark go to their columns. The remark is still the
      first comment, and `fields.severity` stays for the severity-notification rule.
    - The team goes through the engine's explicit `teamId`.
  - **Sandbox seeder:** never seeds an unassigned record. It uses the seeded accounts,
    otherwise the fallback, and skips the module when there's nobody at all.
  - **Vendor demo script:** an `--assignee` argument (defaults to the first `--notify` user),
    needed only when it creates a vendor, plus due date, remark and severity on every vendor.
  - **Workflow owner on install:** installing a module records the installer as owner of its
    seeded workflows that have none.
    - Covered: the admin install route, and sandbox provisioning (the sandbox's admin account).
    - Tenant provisioning records no one: the actor is a platform operator, not a tenant
      member, and ADR-006 makes a workflow's creator its admin. Those workflows use the
      run-time admin fallback.
- **Tests.**
  - Fallback resolver: every step and every "nobody" case.
  - Template defaults: template wins, defaults, older assignee, team, no-assignee failure.
  - Executor actions with the defaults; a non-ticket type created as before; `NO_ASSIGNEE`
    not tripping the circuit breaker.
  - The automation-rule API keeps a valid template and rejects invalid values.
  - Scheduler: due date from creation, teamId, remark and severity columns.
  - Seeder: fallback used, module skipped, no lookup with accounts.
  - Install route passes the admin, plus a database-backed test that the installer is recorded
    and an existing owner is kept.
  - Isolation suites updated for the new rule, both passing locally:
    - `sandbox-module-data-seed` now seeds the admin account, and asserts every record has
      all five values and the admin owns the workflows.
    - `automation-create-child` stands in for the worker's resolver, and asserts tender's
      rule creates a complete, assigned sub-task.
- **Next.** PR 2.3: edits can't remove a mandatory value (PATCH, bulk PATCH, access revoke),
  severity via PATCH, and erased users' tickets reassigned through the same fallback.
- **Review follow-ups (2026-10-19).** Merged the rebuilt #973 (no conflicts). Vijit approved
  with non-blocking notes; fixed:
  - A rule's saved assignee (template or the older single-assignee setting) is used only while
    still a tenant member; a departed one falls through to the fallback owner, and to
    `NO_ASSIGNEE` if there is none.
  - `AutomationError` takes its message at construction; `NO_ASSIGNEE` no longer rewrites it.
  - `workflowOfType` is one query, the tenant's own workflow before a global template.
  - The automation template's `assignedTo` rejects blank values without trimming the id.
- **Review R2 (2026-10-19).** Rebuilt on `main` after #973 merged, as abmish asked: this PR is
  now `main` + its own commit (cherry-picked clean, #830's outbox suppression kept) + the R1
  follow-ups above. The diff drops from 106 files to the PR's own.
  - `team_id` is virtual by config (ADR-004): new entity types get it with
    `config.virtual`, and migration 0151 sets the flag on existing ones. The create, admin
    create and ticket pages no longer check the name; the ticket's team shows in the
    assign control ("Team: <name>"), not as a field-grid row.
