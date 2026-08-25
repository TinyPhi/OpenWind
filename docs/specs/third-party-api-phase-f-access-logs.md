# Third-Party API Phase F — API Access Logs Screen

> The dedicated, admin-only screen that is the primary place to investigate any third-party
> application's behavior — separate from the ticket timeline, plus proactive misuse alerting.

status: draft
created: 2026-08-25
updated: 2026-08-25 (retention-policy correction: 90-day rolling + purge-anonymization per Round 7
GAP-06, not the earlier superseded "indefinite" decision this spec was first drafted against)

---

## §G Goal

An admin-only screen lists every third-party API request/attempt (Phases B–E: application,
acting person, action, ticket if applicable, allowed/denied, timestamp), filterable by
application/person/ticket/date-range/allowed-vs-denied. Three baseline misuse triggers notify
OpenWind admins proactively via the platform's existing notification system. Denied attempts are
confirmed absent from every ticket timeline, verified end-to-end across every phase B–E action
type together (not per-phase in isolation, which is all that's been checked so far).

## §C Constraints

| constraint   | value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| stack        | Admin-ui screen (Refine + shadcn/ui, matching every other admin screen) backed by `@platform/audit`'s **already-existing** `queryAuditLog` function (`packages/audit/src/index.ts`) — filters by actorId/actorType/resourceType/resourceId/date-range/cursor-pagination are all already implemented; this phase adds the UI, an application/ticket-name resolution layer, and the misuse-alert logic, not a new query engine                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| auth         | Admin-only (existing `requireRole("admin")` convention, no new auth surface)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| data source  | `admin_audit_log` rows already written by every Phase B–E third-party route via `writeAuditEntry` — no new write path for logging itself, only new reads + 3 new alert-trigger writes (via the existing notification system)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| retention    | **Correction (2026-08-25): the 2026-08-14 "indefinite retention" decision this spec was originally drafted against was superseded by Round 7's GAP-06 (2026-08-18)** — indefinite retention was judged a live DPDP/GDPR compliance risk. Actual policy: rolling 90-day retention on detailed rows + immediate anonymization (not deletion — action/ticket/outcome/timestamp survive, PII fields replaced with placeholders) on tenant purge; aggregate counts roll up and survive past 90 days. **The sweep/anonymization job itself is Phase G's implementation task, not this phase's** — but this phase's screen must render anonymized rows correctly (placeholder text, still filterable by action/outcome, never erroring on a null/placeholder person field) from day one, since Phase G's sweep can start running before or after this screen ships. |
| out of scope | a new query/storage engine for the log itself (already exists); building anomaly/behavioral modeling for the volume-spike trigger (threshold-based only, explicitly accepted residual risk — see §V); a new auth surface                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| depends on   | Phases B–E's `writeAuditEntry` calls (B/C/D done and merged; E open as PR #484, this branch stacks on top of it) for there to be real data to show; no hard _code_ dependency otherwise (screen logic works today against Phase A's existing key-action audit rows)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## §I Interfaces

```
GET /api/admin/third-party-access-logs
  query: { application?: apiKeyId, personId?: string, ticketId?: string,
           from?: ISO date, to?: ISO date, outcome?: "allowed" | "denied",
           cursor?: string, limit?: number }
  -> { data: AccessLogRow[], nextCursor: string | null }

AccessLogRow: {
  id, timestamp, applicationName, applicationKeyId, actingPersonId,
  ticketId | null, action, outcome: "allowed" | "denied"
}
```

`outcome` is derived, not a stored column: an action name ending in a phase's own denial suffix
(`.access_denied`, or a phase-specific equivalent — e.g. Phase C's `tag.misuse_rate_capped`, which
is a denial in effect even though its name doesn't end in `.access_denied`) maps to `"denied"`;
everything else maps to `"allowed"`. §V records the exact mapping table as an invariant so a
future phase's new action name doesn't silently fall through to the wrong bucket.

No new DB table for the log itself. New: a small `misuse_alerts` audit trail (or reuse
`admin_audit_log` with `actorType: "system"` — open question, see §T) recording each fired alert,
so an admin can see alert history alongside the raw log.

## §R Requirements

R1: Every third-party request/attempt across Phases B–E is visible on this screen with full
attribution.
✓ A successful ticket-create, comment-post, sub-ticket-create, attachment-upload, and transition
each appear as an `"allowed"` row with the correct application, acting person, and ticket ID.
✓ A denied attempt from each of those same action types (wrong scope, access-denied,
cross-tenant, invalid-transition) appears as a `"denied"` row with the same attribution fields.

R2: The screen is filterable/searchable by application, by person, by ticket, by date range, and
by allowed-vs-denied, in any combination.
✓ Filtering by `application` returns only rows where that key was the actor, across every action
type.
✓ Combining `ticketId` + `outcome: "denied"` returns exactly the denied attempts against that one
ticket, excluding its allowed ones.

R3: Denied attempts never appear in a ticket's own timeline (`workflow_events`) — confirmed
end-to-end across every Phase B–E action type together, not just per-phase.
✓ For each of comment-post, sub-ticket-create, attachment-reference, and transition, a denied
attempt against a real ticket produces zero new `workflow_events` rows for that ticket, while
still producing exactly one `admin_audit_log` row.

R4: Three baseline conditions trigger a proactive admin notification, each independently testable.
✓ N failed-authentication attempts on the same key within a rolling window (config-driven
threshold, mirroring the existing `checkRateLimit` pattern) fires exactly one alert per breach,
not one per subsequent failure.
✓ A key's request volume exceeding a configured multiple of its own rolling baseline fires an
alert.
✓ A ticket hitting its Phase C tagging-driven access-grant cap (`tag.misuse_rate_capped`, already
logged today) fires this same alert mechanism — not a separate one.
✓ None of the three fires under normal, below-threshold usage (explicit negative test per
trigger).

R5: The accepted residual risk of trigger 2 (sustained near-threshold abuse evading a
volume-spike alert) is stated on the screen itself, not only in an internal doc/checklist.
✓ The screen's UI displays this caveat somewhere a reviewing admin will actually see it (e.g. an
info tooltip/banner near the misuse-alerts section), not buried in a README.

R6: The screen renders an anonymized row (Phase G's future purge-triggered scrub) without
erroring, even though Phase G hasn't shipped yet when this phase does.
✓ A row with a placeholder value in a person/identity field (simulated, since Phase G's sweep
doesn't exist yet) still displays, remains filterable by action/outcome/ticket, and doesn't crash
a `personId` filter that happens to match the placeholder literal.

## §V Invariants

- Log retention is **90-day rolling detail + purge-triggered anonymization** (Round 7 GAP-06,
  2026-08-18 — supersedes the earlier 2026-08-14 "indefinite" decision this spec initially cited
  in error). This phase does not implement the sweep/anonymization job (that's Phase G's task),
  but must never assume every row has live, non-placeholder PII fields — the screen has to
  degrade gracefully on an already-anonymized row regardless of which phase's code ran the
  anonymization.
- The action-name-to-outcome mapping (which action strings mean "denied" vs "allowed") is
  centralized in ONE place (not re-derived ad hoc per screen/query) and every new
  `AuditAction` value added by a future phase must be classified into this mapping in the same
  commit that adds the action — mirrors the established "extend the TS union + the DB CHECK
  constraint in the same commit" rule from the Phase C B1 incident, applied to a new axis
  (semantic classification, not just allowlisting).
- The three misuse-alert triggers reuse the platform's existing notification system
  (`@platform/notifications`) — this phase does not stand up a second/parallel alerting channel.

## §T Tasks

| id  | task                                                                                                                                                                                                                                                                                                          | phase | status | depends        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | -------------- |
| T1  | Outcome-classification module: centralized action-name → `"allowed" \| "denied"` mapping covering every `AuditAction` value that exists today (base + tag.\* + attachment.\* + transition.\*)                                                                                                                 | 1     | todo   | —              |
| T2  | Admin route `GET /api/admin/third-party-access-logs` — wraps the existing `queryAuditLog`, joins/resolves `applicationName` from `api_keys` by actorId, applies T1's outcome classification, adds the `outcome` filter (queryAuditLog itself has no such filter yet — needs a small extension or post-filter) | 1     | todo   | T1             |
| T3  | Admin-ui screen: filterable table (application/person/ticket/date-range/outcome), matching the existing admin screen conventions; renders a placeholder/anonymized row without erroring (spec R6, ahead of Phase G's sweep landing)                                                                           | 1     | todo   | T2             |
| T4  | End-to-end isolation test: for each of comment-post/sub-ticket-create/attachment-reference/transition, a denied attempt produces zero `workflow_events` rows and exactly one `admin_audit_log` row (spec R3)                                                                                                  | 1     | todo   | T1             |
| T5  | Misuse-alert trigger 1 (repeated auth failures) + trigger 2 (volume spike) — new Redis-backed counters (reusing `checkRateLimit`'s pattern, not its exact key shape) feeding `@platform/notifications`                                                                                                        | 2     | todo   | —              |
| T6  | Misuse-alert trigger 3 (tagging-grant-cap breach) — wire the existing `tag.misuse_rate_capped` audit write to also fire the same notification path as T5                                                                                                                                                      | 2     | todo   | T5             |
| T7  | Screen-level residual-risk disclosure (spec R5) for trigger 2                                                                                                                                                                                                                                                 | 2     | todo   | T5             |
| T8  | Isolation tests for all 3 triggers (fires under threshold-breach, doesn't fire under normal usage) + `/security-review` (admin-only auth boundary, cross-tenant log isolation) + `/review` + docs marker + PR                                                                                                 | 2     | todo   | T4, T5, T6, T7 |

phase gate: all unit + isolation tests pass, `/security-review` clean, before PR opens

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |
| —   | —           | —          | —               |

---

_spec is source of truth — update as decisions are made_
