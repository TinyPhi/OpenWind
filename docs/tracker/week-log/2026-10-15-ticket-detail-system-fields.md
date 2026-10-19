# 2026-10-15 — mandatory ticket fields, PR 1 (title protected, fields visible)

**Session type:** Owner bug reports from local and server testing, then an interview
**Branch:** `fix/ticket-detail-system-fields` (stacked on #934's branch)
**Spec:** [mandatory-ticket-fields](../../specs/mandatory-ticket-fields.md) (R1, R2, R3, R10)

- **Reported.**
  - A helpdesk ticket's detail page showed no title anywhere, and Edit had no title input.
  - On the server, a schedule rule assigned to a user failed with 400 "assignedTo invalid".
- **Causes.**
  - `is_system` meant two things. In the ADRs (ADR-004 CF-01, ADR-016 D3) it means
    protected. The record view treated it as hidden. The helpdesk seed marks every ticket field
    system, so the view hid them all, although the values were saved.
  - The schedule-rule template validated `assignedTo` as a UUID, but Zitadel user ids are
    numeric. Tests used made-up UUID ids, so it never showed up. A colleague who had never
    signed in would also have failed the membership check.
- **Two attempts dropped before commit.**
  - Removing the UI filter alone would have shown tender's engine-written fields as inputs.
  - Marking the helpdesk fields non-system contradicted ADR-016 D3 and ADR-004 CF-01.
- **Owner rule (interview).** Every ticket on every workflow, sub-tasks included, always has
  title, due date, remark, assignee (user or team) and severity. They can't be made optional.
  Other fields are per workflow and can be made required. The eight decisions are recorded in
  the spec. This PR covers the title and the ticket page; PR 2 covers enforcement everywhere
  plus a backfill.
- **What changed.**
  - Title is required and protected on every workflow. That covers every module seed (vendor
    gains a title), workflows built in the UI, and existing tenants via migration
    `0150_title_protected_required` (applied locally: 21 titles; first numbered 0145, renumbered after upstream took 0145–0149). A blank title is rejected.
  - System fields show everywhere: ticket view, Edit form, heading, list title search and
    admin create. Hiding is now field `config.readOnly`, set on tender's
    `submitted_at`/`submitted_by`: text in the view, never an input or a create-form field.
  - The field admin page and the workflow builder hide edit and delete on system fields. The
    builder also pins them in drag-reordering, so it never sends them a sort-order change
    the API would refuse (which used to leave an order half-saved).
  - Helpdesk still seeds a `severity` field next to the built-in severity column. The ticket
    page and both create pages leave that field out, so there's one Severity control, and
    `team_id` is never a free-text input in Edit (blanking it would orphan a team ticket).
  - Ticket page:
    - Edit and quick-assign have no "Unassigned"; a team ticket keeps its team.
    - The due date can't be cleared, and a changed one must be in the future (an untouched
      overdue date still saves).
    - Severity is in Edit, sent only when the user changes it (an older ticket with none
      isn't silently set to Medium); remark stays fixed.
    - The sidebar due date drops a pending save when the value turns blank or past.
    - Saving no longer shifts the due date by the browser's timezone offset.
  - The schedule rule accepts Zitadel user ids and registers a never-signed-in org member,
    the same way ticket create does.
- **Tests.**
  - A guard test parses every module seed: each workflow type has a required, protected
    title; protection appears only on titles plus an allowlist; tender's engine fields are
    read-only. It fails against the old seeds, naming all eight types.
  - Blank-title validation.
  - Ticket page: view, edit, blank title, no unassign, team kept, overdue edit, past and
    cleared due date, severity, read-only field, child ticket. All nine fail on the old page.
  - Title search, both create pages, the field admin page, and the builder's pinned reorder.
  - Every changed module seed was also executed against a local database for a throwaway
    tenant inside a rolled-back transaction: all ran cleanly with the expected flags.
  - Schedule rules with a real-shaped user id (template, route POST/PATCH, tick worker).
- **Deploy.** `db:migrate` for 0150, then rebuild backend, worker and frontend.
- **Open.** ADR-012 amendment (partner API fallback owner) is a human task in BLOCKERS.md;
  it blocks only spec T11.
