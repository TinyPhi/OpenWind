# Dashboard Severity/Tags/Origin Surfacing

> personal dashboard shows severity, tags, origin on tickets — already shipped on
> records/detail pages, dashboard is blind to them today.

status: draft
created: 2026-09-05
updated: 2026-09-05

---

## §G Goal

A user's personal dashboard (`/dashboard`, `apps/admin-ui/src/pages/dashboard.tsx` +
`apps/api/src/routes/dashboard/my-view.ts`) surfaces the same severity/tags/origin data
already visible on the records page and ticket-detail page — read-side only, no new
tables/endpoints/migrations.

## §C Constraints

| constraint   | value                                                                                                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack        | apps/admin-ui (React), apps/api's `/dashboard/my-view` route + its `schemas.ts` zod contracts                                                                                                             |
| auth         | unchanged — this is a display-layer addition to an existing authenticated, per-user-scoped endpoint                                                                                                       |
| data source  | `entity_instances.severity` / `entity_instances.originMechanism` (already selected in scope, just not returned) + `entity_instance_tags` (batch-fetched, mirroring `resolve-origin-display.ts`'s pattern) |
| out of scope | new tables, new endpoints, migrations, editing severity/tags from the dashboard (display only — edits still happen on ticket-detail), tags on the due-dates/SLA-risk lists (main ticket list only)        |

## §I Interfaces

Additive fields only — existing dashboard types/schemas gain fields, nothing removed/renamed.

`TicketSummarySchema` (schemas.ts) / `TicketSummary` (dashboard.tsx) gain:

- `severity: "low" | "medium" | "high" | "critical" | null`
- `tags: string[]` (already-normalized tag text, in creation order)
- `origin: "internal" | "external" | "redirected"`

`DueDateItemSchema` / `DueDateItem` and `SlaRiskItemSchema` / `SlaRiskItem` gain:

- `severity: "low" | "medium" | "high" | "critical" | null`
- `origin: "internal" | "external" | "redirected"`
- (no `tags` — terse lists, tags omitted by design, see R2)

New KPI tile filter value: `"critical-high"` added to the existing `TicketFilter` union
(`"all" | "due-soon" | "overdue" | "due-week" | "at-risk" | "critical-high"`).

New aggregation `buildSeverityMix` (mirrors `buildStateMix`, dashboard.tsx:199-218):
`Array<{ severity: TicketSeverity; count: number }>`.

## §R Requirements

R1: Dashboard ticket rows show severity as a colored visual indicator, consistent with the
records page.
✓ Each row in the main ticket list (`TicketRow`) renders a left-border stripe colored via
the same `SEVERITY_COLOR` mapping used on the records page — no text badge (matching the
records-page precedent of border-not-badge)
✓ A ticket with `severity: null` (pre-feature legacy row) renders with no stripe — same as
today's unstyled row, no error/placeholder state
✓ SLA-risk rows also render the severity stripe (their existing `hoursOver`-based color
coding is a distinct, unrelated "how late" indicator and is unchanged)

R2: Dashboard main ticket rows show the ticket's tags.
✓ Each `TicketRow` renders its ticket's tags as small colored chips, using the same
deterministic per-tag-text hash coloring as ticket-detail's tag chips
✓ A ticket with zero tags renders no chip row (no empty-state clutter)
✓ Due-dates and SLA-risk lists do NOT render tags — those lists stay terse by design

R3: Dashboard rows show a ticket's origin (external/redirected) the same way the records
page does.
✓ A ticket with `origin: "external"` or `"redirected"` shows a small pill next to the
workflow name; `"internal"` shows nothing (unchanged default, matches records page)
✓ This pill appears on the main ticket list, due-dates list, and SLA-risk list alike (origin
is cheap/high-signal, unlike tags — see R2)

R4: The dashboard's KPI tiles let a user filter to just their critical/high-severity
tickets, the same way the existing tiles filter by due-date/SLA-risk membership.
✓ A 5th KPI tile, "Critical/High", shows the count of the user's tickets with severity in
{high, critical}
✓ Clicking it applies the same client-side `ticketFilter` mechanism the 4 existing tiles use
— no new fetch, filters the already-loaded `view.tickets.items`
✓ The tile's count and the filtered list agree (same severity-membership check)

R5: The dashboard shows a severity breakdown, mirroring the existing state-mix donut.
✓ A `buildSeverityMix` aggregation (server or client, matching where `buildStateMix` lives)
produces per-severity counts across the user's tickets
✓ Rendered as a second small donut/bar widget alongside the existing state-mix chart, using
the same `SEVERITY_COLOR` mapping as R1's stripe

R6: All new fields are additive to existing API contracts — no breaking change.
✓ Existing consumers of `/dashboard/my-view` that don't read the new fields are unaffected
(zod schemas add optional-shaped-but-always-present fields, not remove/rename any existing
field)
✓ A pre-existing ticket row with `severity: null`/no tags/`origin: "internal"` round-trips
through the new fields without any special-casing beyond what R1/R2/R3 already specify

## §V Invariants

- Dashboard severity/tag/origin display is read-only — no new write path is introduced;
  editing continues to happen exclusively on the ticket-detail page (matches
  ticket-severity-and-tags.md's existing invariant that severity/tags are edited only where
  edit-access is already enforced).
- Tags are never rendered on the due-dates or SLA-risk lists — a deliberate, permanent
  scope line (not a "not yet implemented" gap), to keep those lists terse.
- No N+1 query pattern for tags — always a single batch fetch across the page's ticket ids,
  mirroring `resolve-origin-display.ts`'s existing batch-lookup precedent.

## §T Tasks

Full phase-gated breakdown: `docs/specs/dashboard-severity-tags-origin-tasks.md`

| id  | task                                                                                                        | phase | status | depends |
| --- | ----------------------------------------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1  | my-view.ts: select severity/originMechanism in buildTicketsSection/buildDueDatesSection/buildSlaRiskSection | 1     | todo   | —       |
| T2  | my-view.ts: batch-fetch tags for the main ticket list's page of ids (buildTicketsSection only)              | 1     | todo   | T1      |
| T3  | schemas.ts: add severity/tags/origin fields to TicketSummarySchema/DueDateItemSchema/SlaRiskItemSchema      | 1     | todo   | T1,T2   |
| T4  | dashboard.tsx: mirror new fields onto TicketSummary/DueDateItem/SlaRiskItem TS types                        | 2     | todo   | T3      |
| T5  | dashboard.tsx: severity stripe on TicketRow + SLA-risk rows                                                 | 2     | todo   | T4      |
| T6  | dashboard.tsx: tag chips on TicketRow                                                                       | 2     | todo   | T4      |
| T7  | dashboard.tsx: origin pill on all three row types                                                           | 2     | todo   | T4      |
| T8  | dashboard.tsx: 5th KPI tile "Critical/High" + `ticketFilter` union extension                                | 3     | todo   | T5      |
| T9  | dashboard.tsx: buildSeverityMix + severity breakdown widget                                                 | 3     | todo   | T5      |
| T10 | tests: route/schema tests for T1-T3, component tests for T5-T9                                              | 1-3   | todo   | T1-T9   |

phase gate: all unit + integration tests pass before advancing to next phase

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |

---

_spec is source of truth — update as decisions are made_
