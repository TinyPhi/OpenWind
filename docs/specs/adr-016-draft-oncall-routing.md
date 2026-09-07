# ADR-016 DRAFT: On-Call Routing & Severity-Based Notification Dispatch

> **DRAFT — for human review before committing to `docs/decisions/ADR-016-*.md`.**
> Per this repo's rules, ADR files in `docs/decisions/` are human-authored. Review this draft,
> adjust as needed, and commit it there with `Status: Accepted` once the team agrees.

**Status:** Draft
**Date:** 2026-09-06
**Deciders:** Engineering Lead
**Related to:** ADR-012 (third-party API access), ADR-013 (rate limiting), ADR-014 (notification
SLA/retry), issue #16 (3A tracker), issue #12 (2A — Novu wire-up)
**Supersedes:** —
**Superseded by:** —

---

## Context

### Problem 1 — Ticket assignment bottleneck

Today every ticket requires an agent to know the right person to assign it to. When that
knowledge is absent, tickets either sit unassigned, get assigned to a manager who re-assigns
manually, or default to whoever was most recently active. Over time, one or two people in a
team absorb a disproportionate share of incoming volume. There is no team-level routing
concept in the platform — only per-user assignment.

### Problem 2 — No structured on-call coverage

Teams that want to share on-call load have no first-class tooling. Schedules are maintained
externally (spreadsheets, Google Calendar, Slack pinned messages) and do not connect to
ticket routing. A week-change in on-call coverage requires someone to remember to update a
pinned message; no automation enforces consistency.

### Problem 3 — Notifications are severity-blind

`@platform/notifications` (Novu-based, Phase 2A) delivers in-app and email notifications but
has no concept of priority or urgency. A critical production incident and a low-severity
feature request arrive via the same channel with identical delivery semantics. There is no
configurable escalation: "for critical issues, also page the on-call over SMS and make a voice
call." This is partially addressed by ADR-014's retry/exhaustion policy (which preserves the
delivery attempt) but not at the routing/channel-selection layer.

### What already exists that this ADR builds on

- `@platform/notifications` (Novu wrapper, Phase 2A) — email + in-app channels working today
- `@platform/automation-engine` — event-driven rule executor with pluggable action types
- Entity engine `entity_ref` field type — cross-tenant reference guard already built
- `admin_audit_log` — append-only, tenant-scoped, already carries dot-notation action strings
- ADR-014's delivery-failure shape (system note + admin alert) applies unchanged to
  `notification.channel_failed` entries from this feature

---

## Decision

### Decision 1 — Teams and services as their own DB tables, not entity-engine entity types

Teams and services are structural routing anchors, not business records with arbitrary custom
fields. On-call lookup is a hot path (fires on every team-assignment event); it must be a
single indexed query, not a JSONB traversal across `entity_instances`. The entity engine's
schema-cache layer adds latency and cache-invalidation complexity that is unnecessary here.

Teams and services get their own Drizzle-managed tables (`teams`, `services`) with explicit
RLS policies and analytics annotations, the same pattern as `api_keys`, `on_call_schedules`,
and every other structural table in the platform.

**Not chosen:** Making teams an entity type in the entity engine would reuse the custom-field
machinery but would tie on-call lookup performance to schema-cache health and complicate the
FK relationship with `on_call_schedules`.

### Decision 2 — On-call schedules as time-window rows with DB-level overlap prevention

Each `on_call_schedules` row covers a (tenant, team, [starts_at, ends_at)) window and names a
primary, optional backup, and optional escalation manager. Overlapping windows for the same
team within a tenant are prevented by a PostgreSQL GIST exclusion constraint on the
`tstzrange(starts_at, ends_at)` expression — not just an application-layer check. This
matches the same pattern used for `entity_instances`' concurrent-transition pessimistic lock:
correctness at the DB layer, application code as a UX layer on top.

Coverage gaps (windows where no row exists for a team) are surfaced by the
`GET /admin/on-call-schedules/current` snapshot endpoint and a badge in the admin UI. The API
does not auto-fill gaps.

### Decision 3 — Three new system ticket fields + a dedicated labels table

Severity (`critical`/`high`/`medium`/`low`) and entity-ref fields for team and service are
added to the ticket entity type as **system fields** (`isSystem: true`) via seed SQL. They
cannot be deleted via the custom-field API — same invariant as other system fields on existing
entity types.

**Labels are not an entity engine field.** The original design used a free-text `multi_select`
field called `tags` (JSONB array). This was replaced with a proper `labels` table (name, color,
description, per-tenant) and a `ticket_labels` junction table. Labels are managed through their
own CRUD API (`/admin/labels`) and assigned to tickets via `/tickets/:id/labels` endpoints.

**Why not a free-text tags field:** free-text tags provide no consistent vocabulary, no visual
color identity, and no way to efficiently filter or group tickets by a canonical tag value
across the tenant. GitHub-style labels — a tenant-managed vocabulary with required hex color —
solve all three gaps. Admins define the vocabulary once; agents apply labels from a picker;
the filter API uses label IDs, not string matching.

**Why not entity engine field:** the entity engine's `multi_select` stores arbitrary strings.
Making labels structured (name + color + description) requires a first-class table with its own
UNIQUE constraint and soft-delete semantics. A junction table (`ticket_labels`) is the correct
relational shape for many-to-many; it also gives a clean audit trail for assignment history
even after a label is soft-deleted.

Custom ad-hoc fields remain available via the existing `addEntityField()` path when
`allowCustomFields: true`. This decision adds no new custom-field mechanism.

### Decision 4 — Two new automation action types: `resolve_oncall` and `dispatch_severity_notification`

Both hook into the existing `executeAutomationRules()` execution pipeline with no changes to
the rule evaluator, circuit breaker, or recursion guard. They are new leaf-node action types
in the same action dispatch table.

`resolve_oncall`: triggered when `team_id` is set/changed on a ticket. Resolves the current
on-call schedule entry for the team, sets `assignee` to the primary, tags the backup.
Fail-open: no active schedule → ticket unchanged, `oncall.no_schedule` audited.

`dispatch_severity_notification`: triggered when `severity` is set/changed on a ticket.
Resolves the notification policy (see Decision 5), dispatches the resolved channel list,
audits per channel. Decoupled from the ticket mutation transaction — channel failures never
roll back the ticket write (ADR-014's precedent applied here).

Idempotency: both actions compare the triggering field value against the last-processed value
before acting. Re-delivering the same event version produces no second write.

Explicit-assignee-wins: if `assignee` is set on the same request as `team_id`, the explicit
value is used and `resolve_oncall` is skipped (`oncall.skipped_explicit_assignee` audited).

### Decision 5 — Specificity-scored notification policies

`notification_policies` stores (tenant, optional team, optional workflow_type, severity) →
channel list. At dispatch time the engine scores all matching policies by specificity (team set
= +2, workflow_type set = +1), takes the highest-scoring match, and falls back to the global
(no team, no workflow_type) policy for that severity, then to email-only as a hardcoded last
resort. Two policies at the same specificity level for the same (tenant, team, workflow_type,
severity) tuple are rejected at write time (`409`) — the uniqueness invariant is enforced via
partial indexes (not a single composite unique constraint, because `NULL != NULL` in
PostgreSQL composite uniques makes null-dimension slots ambiguous).

This design is intentionally additive: a tenant with no notification policies gets email-only
everywhere, same as today. Policies are layered on top of the default, not required.

### Decision 6 — New channels (SMS, WhatsApp, call) through Novu, not a new package

`@platform/notifications` already wraps Novu. Novu natively supports SMS, WhatsApp Business,
and voice (via Twilio and equivalent providers). Adding the new channels is a matter of wiring
new Novu provider configurations and environment variables, not a new package or a new
delivery pipeline. No new `@platform/*` package is introduced.

Retry/exhaustion for these channels follows ADR-014's existing policy unchanged (3 BullMQ
attempts, exponential backoff, system note + admin alert on exhaustion). No cross-channel
failover (ADR-014 Decision #5 explicitly deferred this — no new evidence to revisit it yet).

---

## Consequences

### Positive

- Ticket assignment load distributes automatically across the roster once schedules are
  configured; no per-ticket manual re-routing for team-bound tickets.
- Severity is a first-class signal for both routing and notification urgency; a critical
  incident gets called out over voice while a low-severity issue gets an email.
- Both features compose with existing automation rules: a team owner can add more conditions
  on top of the system-seeded rules without touching code.
- No new delivery infrastructure: Novu already handles retries, provider failover (within a
  channel), and exhaustion notification; the new channels are provider-config additions.
- Notification policy is additive: tenants that don't configure policies see no change in
  behaviour.

### Negative and mitigations

- **On-call resolution latency adds ~100 ms to ticket writes** that trigger the automation.
  Mitigation: single indexed lookup (`WHERE team_id = X AND now() BETWEEN starts_at AND
ends_at`) on a GIST-indexed column; p99 target ≤ 100 ms enforced by an integration test.
- **Voice/call channel requires Twilio Voice credentials** — a new ops dependency beyond
  existing Twilio SMS. Mitigation: the channel is opt-in per notification policy; a tenant
  that never configures it sees no new provider requirement.
- **Coverage gaps (no active schedule for a team) are surfaced but not auto-filled.** A ticket
  assigned to a team with no schedule entry loses automatic routing. Mitigation: UI badge +
  `oncall.no_schedule` audit entry make the gap visible; the admin can create a retroactive
  schedule entry to cover the gap.
- **Severity-change-only dispatch (not every-update dispatch)** means a ticket whose severity
  is unchanged across updates will not re-notify. This is the correct behaviour but may
  surprise admins who expect a re-notification on state changes. Mitigation: documented in the
  design doc; a separate automation rule on `entity.updated` for state changes can be added
  per workflow if escalation-on-state-change is needed.

---

## Deferred Decisions

| Deferred item                                                                           | Trigger to revisit                                                   | Why deferred                                                                           |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Cross-channel failover (e.g. SMS if email fails)                                        | Pilot customer incident traceable to this gap                        | ADR-014 already explicitly deferred; no new channels even existed then                 |
| Recurring roster templates (auto-generate next week's schedule from a rotation pattern) | Team admin asks for it after manual schedule creation proves painful | Out of scope for v1; roster building is manual but straightforward for weekly cadences |
| External pager integration (PagerDuty / OpsGenie)                                       | Customer using both platforms requests it                            | No customer demand yet; Novu voice covers the alerting need for now                    |
| Multi-timezone DST handling (schedule windows auto-adjust on DST change)                | Complaint from a multi-timezone team                                 | v1 stores UTC; teams are expected to account for DST when creating schedules           |
| Coverage-gap auto-fill with a fallback user                                             | Admin requests it                                                    | Fail-open (leave ticket unassigned) is safer than a wrong auto-assignment              |

---

## Open Questions

| ID   | Question                                                                                                 | Notes                                                                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-1 | Should `services` have their own on-call schedule independent of their owning team?                      | v1: services inherit routing from their team only. A service-level schedule is a natural extension but adds complexity without a clear customer requirement yet. |
| OQ-2 | ~~Should `tags` support a tenant-managed vocabulary or remain fully free-text?~~ **Resolved.**           | Decided: labels table with required name + hex color + optional description. Free-text tags removed. See Decision 3.                                             |
| OQ-3 | Should `dispatch_severity_notification` also fire on initial ticket creation (not just severity change)? | v1: yes, if severity is set at creation time. The trigger checks "severity is being set from null to a value" — same as "changed".                               |

---

## Implementation next steps

1. This draft should be reviewed, adjusted, and committed to `docs/decisions/ADR-016-*.md`
   with `Status: Accepted` by a human (per this repo's ADR authorship rule).
2. Create GitHub issues linking to this ADR for the 4-phase task breakdown in
   `docs/specs/oncall-routing.md`.
3. Begin Phase 1 (DB migrations) once the ADR is accepted — see `§T` in the spec.
