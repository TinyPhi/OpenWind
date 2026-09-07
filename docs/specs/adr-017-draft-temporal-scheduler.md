# ADR-017 DRAFT: Temporal Scheduler — Automatic Ticket Creation on Schedule

> **DRAFT — for human review before committing to `docs/decisions/ADR-017-*.md`.**
> Per this repo's rules, ADR files in `docs/decisions/` are human-authored. Review this draft,
> adjust as needed, and commit it there with `Status: Accepted` once the team agrees.

**Status:** Draft
**Date:** 2026-09-07
**Deciders:** Engineering Lead
**Related to:** ADR-002 (workflow engine), ADR-003 (field validation), ADR-004 (config-first module design),
ADR-014 (notification SLA/retry), ADR-016 (on-call routing — teams/services/severity)
**Supersedes:** —
**Superseded by:** —

---

## Context

### Problem — Recurring workflows require manual ticket creation

Several standard business workflows are inherently time-triggered: a monthly leadership review
that needs slides prepared, a weekly standup that needs a written summary, a quarterly
compliance check, a weekly revenue-vs-target reconciliation. Today, someone must remember to
create the ticket at the right time and fill in the right fields. That memory requirement is
a recurring operational cost: reminders get missed, tickets start late, and the person who
was supposed to be reminded has to be chased.

The platform already has a rich workflow engine, entity engine, and automation engine. What it
lacks is a temporal trigger — a way to say "start this workflow at this time, every week/month,
and assign it to the right person automatically." Once a ticket exists in the workflow, all the
existing tooling (SLA, automation rules, notifications) takes over. The gap is the initial
ticket creation step.

### What already exists that this ADR builds on

- BullMQ worker (`apps/worker`) — already runs SLA scheduler, notification worker, alert worker;
  temporal scheduler is a new tick added to the same process
- Entity engine `createEntityInstance()` — creates tickets with arbitrary fields; temporal
  scheduler calls this directly
- `admin_audit_log` — append-only, tenant-scoped; already carries dot-notation action strings
- On-call routing (ADR-016) — `teams` and `services` tables now exist; schedule rules can
  reference them in the ticket template for auto-assignment
- Severity system fields (ADR-016) — ticket entity type now has `severity` as a system field;
  schedule rules can pre-set severity in the template

---

## Decision

### Decision 1 — DB-polling approach, not BullMQ repeatable jobs

Each schedule rule stores its own `next_fire_at` timestamp. The worker polls once per minute
for rules where `next_fire_at <= now() AND status = 'active'` and executes them.

Considered alternative: use BullMQ's built-in `repeat` option to schedule a repeatable job
per rule. Rejected for three reasons:

1. **State synchronisation burden.** BullMQ's repeatable job state lives in Redis. When a rule
   is paused, updated, or deleted via the API, the corresponding BullMQ job must be found and
   mutated. This creates a two-phase write (DB + Redis) that is hard to keep atomic — the API
   succeeds but the BullMQ job silently isn't removed, or vice versa after a Redis restart.

2. **No per-tenant inspection.** There is no efficient way to list "all repeatable jobs for
   tenant X" from BullMQ. Admin UI features (execution history, rule status, next-fires preview)
   would require DB queries anyway, making BullMQ's scheduler state redundant.

3. **Rolling-deploy safety.** `SELECT FOR UPDATE SKIP LOCKED` on the `schedule_rules` table
   guarantees exactly-once execution across multiple worker instances during a rolling deploy,
   without any Redis coordination.

The DB-polling approach is the same pattern as the existing SLA scheduler (which already polls
the `workflow_instances` table for SLA deadlines). It is consistent with the architecture and
has no new external dependency.

### Decision 2 — Cron expression as the canonical schedule format

Cron expressions (5-field standard) are stored in `schedule_rules.cron_expr` as the canonical
format. The API also accepts a `recurrence` object (friendly structure) that is translated to
cron at write time before storage. The UI exposes friendly presets (every day at X, every Monday
at X, every 1st of month at X, every Nth weekday of month at X) and a raw cron input for power
users.

Considered alternative: store a structured recurrence object (daily/weekly/monthly/custom with
sub-fields). Rejected because:

- Nth-weekday-of-month patterns (e.g. "first Tuesday of every month") are standard cron but
  awkward to express in a custom structured format.
- Many admins already know cron syntax; the raw input is a power-user escape hatch.
- A single format in the DB means validation and `next_fire_at` computation have one code path.

`cron-parser` (existing platform use for connector polling — see `apps/worker/src/sla-scheduler`)
is used for validation and `next_fire_at` computation. `cronstrue` (new lightweight dep) is used
for the human-readable cron description returned in the API response.

### Decision 3 — Closed-whitelist `{{variable}}` title templating

Title and description templates support `{{variable}}` substitution where variables are drawn
from a fixed whitelist: `date`, `month`, `month_short`, `year`, `week`, `rule_name`. Unknown
tokens pass through as literals. Template rendering is a regex replace — no template engine is
involved.

Considered alternative: a full template engine (Handlebars, Mustache, Liquid). Rejected because
server-side template injection (SSTI) is a real risk when user-supplied template strings are
evaluated with a rich engine. The whitelist approach is zero-risk: the substitution function
cannot be made to execute arbitrary code regardless of template content.

The whitelist is designed to cover the most common patterns observed in real recurring workflows
(date-in-title, month-in-title, week-number). It can be extended conservatively without changing
the security model.

### Decision 4 — Skip missed fires by default; catch-up optional with a hard cap

`catch_up: false` (the default) means: if the worker was down when a rule should have fired,
those fires are skipped. `next_fire_at` is advanced to the next future cron time; all missed
fires are logged as `status: 'skipped'` in `schedule_executions`.

`catch_up: true` means: on resume or worker restart, missed fires are executed in chronological
order, capped at a maximum of 24. Fires beyond the cap are logged as `skipped`. The cap is an
absolute safety guardrail — a rule that fires every hour and a worker that was down for a week
would otherwise try to create 168 tickets in a single catch-up run.

Rationale for choosing skip as default: most recurring workflows (weekly review, monthly report)
are date-contextual — a "September leadership review" ticket created in October after a missed
fire is worse than no ticket, because it creates confusion about whether it is the September or
October review. Catch-up is available for workflows where catching up is genuinely useful (e.g.
a daily data import task where a missed day should be replayed).

### Decision 5 — Ticket creation attributed to the rule's creator, not a system user

Tickets created by the scheduler are attributed to `schedule_rules.created_by` (the admin who
created the rule), not to a synthetic "system" user. This maintains the audit trail — the ticket
is traceable to the human who configured it — and avoids the complexity of a special system
identity with elevated permissions.

The `created_by` user must remain active in the tenant for fire-time ticket creation to succeed.
If the user is deactivated, the execution logs `ASSIGNEE_NOT_IN_TENANT` and the ticket is not
created. The admin UI surfaces this via the `failed` status in execution history.

Considered alternative: a per-tenant "scheduler bot" user. Rejected as unnecessary complexity
(requires managing a synthetic identity, roles, and permissions across tenants) for a low-value
improvement. If a user-deactivation failure pattern becomes common, a `system_user_id` column
can be added to `schedule_rules` as a future override.

### Decision 6 — Template re-validation at fire time, not just at write time

Template field values are validated against the entity type schema at rule creation (for
immediate feedback) and again at fire time (as a safety net). Entity type schemas can change
between rule creation and fire — a field may be renamed, removed, or have its type changed.
Fire-time validation failure logs the execution as `failed` with a stable `error_code` and
advances `next_fire_at` rather than blocking the rule. The admin sees the failure in execution
history and can update the template.

The rule is not automatically paused on a single fire failure, because a transient failure
(e.g. entity engine unreachable) would incorrectly disable a working rule. The admin can choose
to pause manually if the failure is persistent.

---

## Consequences

### Positive

- Recurring workflows start automatically without anyone having to remember a date or create
  a ticket manually.
- The scheduler integrates with the existing entity engine, workflow engine, and automation
  engine — once the ticket is created, all existing tooling (SLA, on-call routing from
  ADR-016, severity notifications from ADR-016) applies without any special handling.
- DB-polling is operationally simple: no Redis state to synchronise, no external scheduler
  service, observable via standard SQL queries.
- Template substitution is safe by design — the whitelist approach eliminates SSTI entirely.

### Negative and mitigations

- **1-minute polling granularity means up to 60 s of scheduling jitter.** Acceptable for
  administrative workflows (report prep, review kickoffs); not suitable for sub-minute precision.
  Mitigation: documented constraint; the spec explicitly out-of-scopes second-level granularity.
- **Deactivated rule creator blocks ticket creation.** Mitigation: execution logged as `failed`;
  admin UI surfaces it; admin can update `created_by` or re-create the rule.
- **Entity type schema changes can break existing rules.** Mitigation: fire-time re-validation
  with stable error codes; execution history makes the failure immediately visible; rule not
  auto-paused so it recovers automatically if the schema change is reverted.
- **Tick duration scales with number of due rules.** Mitigation: `SELECT FOR UPDATE SKIP LOCKED`
  allows multiple worker instances to split the load; the due-rules index (`next_fire_at` where
  `status = 'active'`) keeps the poll fast; p99 ≤ 5 s target enforced by integration test.

---

## Deferred Decisions

| Deferred item                                                | Trigger to revisit                                             | Why deferred                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| One-shot (non-recurring) scheduled tickets                   | Admin request for "create this ticket once at 3pm next Friday" | Lower value than recurring; can be modelled as a rule with a future date |
| External calendar sync (Google Calendar, Outlook trigger)    | Customer request for calendar-driven ticket creation           | Requires OAuth per-user and connector-level complexity (Phase 3A)        |
| Sub-minute granularity                                       | Workflow requiring near-real-time triggers                     | BullMQ delayed jobs are the right tool for that; different problem       |
| Multi-ticket templates (one rule creates N tickets per fire) | Admin request for "create one ticket per team"                 | Single-ticket-per-fire keeps execution semantics simple; extend later    |
| Scheduler for non-ticket entity types                        | Request to auto-create meetings, tasks, reviews as other types | Ticket is the highest-value case; generalise once pattern is proven      |

---

## Open Questions

| ID   | Question                                                                                                                      | Notes                                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| OQ-1 | Should admins be able to configure a `system_user_id` on a rule to decouple rule execution from the creator's account status? | v1: no — ticket attributed to creator; revisit if deactivated-user failures become common in pilot data |
| OQ-2 | Should a persistent failure (e.g. 3 consecutive failed executions) auto-pause the rule and notify the admin?                  | v1: no auto-pause; admin monitors via execution history; revisit once execution history UI is live      |
| OQ-3 | Should `GET /admin/schedule-rules` surface the next-fires preview inline (rather than requiring a separate request per rule)? | v1: separate `/next-fires` endpoint; inline preview would increase list endpoint cost                   |

---

## Implementation Next Steps

1. This draft should be reviewed, adjusted, and committed to `docs/decisions/ADR-017-*.md`
   with `Status: Accepted` by a human (per this repo's ADR authorship rule).
2. Create GitHub issues for the 4-phase task breakdown in `docs/specs/temporal-scheduler.md`.
3. Begin Phase 1 (DB migrations 0098–0100) once the ADR is accepted.
