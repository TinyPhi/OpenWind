# 2026-10-16 — mandatory ticket fields, PR 2.1 (engine check, create paths, sub-tasks)

**Session type:** Owner-requested follow-up to PR #965
**Branch:** `feat/mandatory-fields-core` (stacked on #965)
**Spec:** [mandatory-ticket-fields](../../specs/mandatory-ticket-fields.md) (R4; T6 part 1)

- **Why.** The earlier fix put the five-field rule (title, due date, remark, severity, assignee
  or team) only in the create-ticket page and `POST /entities`. Sandboxes, automations, the
  scheduler and bulk create go straight to the engine, so their tickets came out incomplete
  (spec B5). The owner agreed a five-PR split; this is the first.
- **What changed.**
  - **One engine check** (`packages/entity-engine/src/mandatory-fields.ts`) run by
    `createEntity`, `bulkCreateEntities` and `createChildRelation` for every workflow record:
    the record has a workflow, its entity type has one, or it's a sub-task.
    - `MANDATORY_FIELDS_MODE=log` (the default) only logs the missing fields;
      `enforce` rejects with a 422 listing them.
    - The api and worker set the mode at startup, the same pattern as the audit hook, since
      the engine reads no config itself.
    - PR 2.5 switches to `enforce` once every creator supplies all five.
  - **Team assignments survive on every type** (B4). The engine stores an explicit `teamId`
    in `fields.team_id` even when the type has no such field (helpdesk tickets don't), and
    accepts only a live team of the same tenant.
    - A `team_id` sent inside `fields` behaves exactly as before: kept only where the type
      defines it, and never checked or rejected. The review caught that treating it like
      `teamId` would let any caller route a ticket to a team, and would make log mode block
      creates with stale team values.
    - It still counts as "has a team" for the check.
  - **A record's workflow must run its own entity type** (B6).
  - **Bulk create** accepts due date, remark, severity and team per item, and now writes the
    remark column, which it never did. Its workflow and team lookups are cached per batch.
  - A type counts as a workflow type only while its workflow is active.
  - **Sub-tasks require all five at once**: title, a future due date, remark, severity
    (default medium), and exactly one of an assignee or a team.
    - The assignee must belong to the organisation; a never-signed-in member is registered
      from the Zitadel org.
    - The remark is posted as the first comment.
    - The sub-task form on the ticket page asks for all five.
  - **Partner API: no lost tickets.** A ticket or sub-ticket whose requested assignee can't
    be resolved is still created, unassigned, under a narrow logged exemption, until the
    ADR-012 amendment (T11).
- **Tests.**
  - The check itself: what's missing, the exemption, and log versus enforce.
  - A database-backed isolation suite on its own fresh tenants:
    - a team kept on a type with no `team_id` field;
    - another tenant's team rejected on create and on sub-task create;
    - a mismatched workflow rejected;
    - log versus enforce, including a record that leaves `workflowId` out;
    - a sub-task without a title;
    - the partner exemption.
  - Sub-task route: every missing value, past due date, both or neither assignee and team,
    non-member assignee, the remark comment.
  - The two isolation suites that created sub-tasks with the old minimal body
    (`child-ticket-routes`, `ticket-alerts-fixes`) now send all five, with a registered
    tenant member as assignee. Both pass locally, along with `resolve-oncall`.
  - Bulk create pass-through; the ticket-page sub-task form.
- **Next.** PR 2.2: automations, the scheduler (severity and remark into their columns), the
  sandbox seeder, the demo script, and an owner on template-installed workflows. Open
  question for the owner: who owns existing ownerless workflows.
- **Review R1 fixes (2026-10-19).** Rebuilt on the rebuilt #965 (upstream `main` + its R3
  fixes); one conflict in `bulkCreateEntities`, taking upstream's new `resolveInitialState`
  signature.
  - A malformed `workflowId` gets its own error, "Not a valid workflow id", before any query.
  - Sub-task creation checks the team and the five values before locking the parent ticket.
  - The ticket sidebar's due-date input is labelled "Sidebar due date", apart from the Edit
    form's "Due Date".
  - Tests: the partner exemption under enforce; the 15s due-date grace on sub-tasks.
  - The silent remark-comment failure is out of scope; recorded in
    `docs/reviews/pending-review-findings.md`.
