# Third-Party API Phase F — API Access Logs Screen

> The dedicated, admin-only screen that is the primary place to investigate any third-party
> application's behavior — separate from the ticket timeline, plus proactive misuse alerting.

status: draft
created: 2026-08-25
updated: 2026-08-25 (retention-policy correction: 90-day rolling + purge-anonymization per Round 7
GAP-06, not the earlier superseded "indefinite" decision this spec was first drafted against;
spec-review pass: added concrete R4 thresholds/dedup semantics, explicit tenant-isolation
invariant, and PII-redaction invariant)

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
| auth         | Admin-only (existing `requireRole("admin")` convention, no new auth surface). **Tenant-scoped**: the admin route passes the caller's own `tenantId` into `queryAuditLog` exactly as every other tenant-scoped route does — an admin never sees another tenant's rows, regardless of query params supplied. No cross-tenant "platform admin" view exists or is added by this phase.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
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
✓ Trigger 1 (auth failures): default threshold is **10 failed-authentication attempts on the same
key within a rolling 5-minute window** (config-driven, mirroring `checkRateLimit`'s config
shape — the number is a shipped default, not a placeholder). Fires exactly one alert per breach;
re-entering breach state after the window rolls clear starts a new, independent alert (dedup key
= `apiKeyId` + breach-episode start, not global — see below).
✓ Trigger 2 (volume spike): default threshold is **a key's request volume in a rolling 1-hour
window exceeding 5× that same key's trailing-7-day hourly average** (minimum baseline sample of
24 hours of history before the trigger is eligible to fire at all, avoiding false positives on a
brand-new key). Fires an alert on crossing the threshold.
✓ Trigger 3 (tagging-grant-cap): a ticket hitting its Phase C tagging-driven access-grant cap
(`tag.misuse_rate_capped`, already logged today) fires this same alert mechanism — not a separate
one.
✓ None of the three fires under normal, below-threshold usage (explicit negative test per
trigger).
✓ Dedup, per trigger, independently: trigger 1 fires once per breach-episode (silence until the
rolling window clears the offending attempts, then re-arms); trigger 2 fires once per
crossing-episode (silence until volume drops back under the multiple, then re-arms — it does not
re-fire every window while still over threshold); trigger 3 fires once per `tag.misuse_rate_capped`
audit row (already naturally one-shot, since that action itself only logs once per cap-hit per
Phase C's existing behavior — this phase does not add extra dedup logic for trigger 3).

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
- Each admin-facing query is scoped by the caller's own `tenantId`, passed explicitly into
  `queryAuditLog` — no query parameter can widen the result set to another tenant's rows.
- `metadata` field values already went through `redactMetadata`/`buildSensitivityMap` at write
  time (per `@platform/audit`'s existing redaction contract) — this screen renders what's already
  redacted and must not additionally decode/unredact anything, since admin-only visibility is not
  a substitute for the write-time redaction already in place.
- Every third-party route writing an `admin_audit_log` entry with `actorType: "api_key"` must set
  `actorId` to the API key's own id (via `applicationActorIdFromUserId(auth.userId)` —
  renamed from `apiKeyIdFromUserId` to avoid CodeQL's clear-text-logging naming heuristic,
  PR #489), never
  `actingPersonId` — the column pairing only works (and `applicationName` resolution only
  succeeds) if `actorId` identifies the key and `actingPersonId` identifies the person, per §B2.
- A route or shared helper that mutates ticket state or gates access on the third-party API must
  not be assumed to already write `admin_audit_log` just because a sibling route does — verify by
  grepping for the actual `writeAuditEntry` call, per §B1.

## §T Tasks

| id  | task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | phase | status | depends        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ------ | -------------- |
| T1  | Outcome-classification module: centralized action-name → `"allowed" \| "denied"` mapping covering every `AuditAction` value that exists today (base + tag.\* + attachment.\* + transition.\*)                                                                                                                                                                                                                                                                                                                                                                                                                                              | 1     | done   | —              |
| T2  | Admin route `GET /admin/third-party-access-logs` — wraps the existing `queryAuditLog`, joins/resolves `applicationName` from `api_keys` by actorId, applies T1's outcome classification, adds `outcome`/`actingPersonId` filters (queryAuditLog itself had no such filters — added as a small, additive extension to `@platform/audit`)                                                                                                                                                                                                                                                                                                    | 1     | done   | T1             |
| T3  | Admin-ui screen: filterable table (application/person/ticket/date-range/outcome), matching the existing admin screen conventions; renders a placeholder/anonymized row without erroring (spec R6, ahead of Phase G's sweep landing)                                                                                                                                                                                                                                                                                                                                                                                                        | 1     | done   | T2             |
| T4  | End-to-end isolation test: for each of comment-post/sub-ticket-create/attachment-reference/transition, a denied attempt produces zero `workflow_events` rows and exactly one `admin_audit_log` row (spec R3)                                                                                                                                                                                                                                                                                                                                                                                                                               | 1     | done   | T1             |
| T1b | **Scope expansion discovered during T4** (see §B): comments.ts/children.ts/attachments-reference.ts wrote NO admin_audit_log entries at all before this phase — retrofitted onto transitions.ts's atomic allowed/denied write pattern (6 new AuditAction values, migration 0081, renumbered twice: 0079→0080 after PR #484's migration took 0079, then 0080→0081 after PR #488 took 0079 upstream, bumping PR #484's migration to 0080). Also fixed actorId across all 4 third-party routes (incl. transitions.ts) to record the actual API key id, not actingPersonId — required for applicationName resolution (spec R1) to work at all. | 1     | done   | T1             |
| T5  | Misuse-alert trigger 1 (repeated auth failures, wired via requireTicketScope's 403 branch) + trigger 2 (volume spike) — Redis-backed counters in `apps/api/src/lib/misuse-alerts.ts`, firing a new `@platform/notifications#fireMisuseAlert` (a `system.error` outbox event reusing ADR-014's existing admin-alert channel)                                                                                                                                                                                                                                                                                                                | 2     | done   | —              |
| T6  | Misuse-alert trigger 3 (tagging-grant-cap breach) — wire the existing `tag.misuse_rate_capped` audit write to also fire `fireMisuseAlert`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 2     | done   | T5             |
| T7  | Screen-level residual-risk disclosure (spec R5) for trigger 2 — already satisfied by T3's caveat text from Phase 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 2     | done   | T5             |
| T8  | Isolation tests for triggers 1+2 (real Redis + real routes) + trigger 3's existing unit test + `/security-review` + `/review` + docs marker + PR                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 2     | done   | T4, T5, T6, T7 |

phase gate: all unit + isolation tests pass, `/security-review` clean, before PR opens

## §B Bugs / Backprop Log

| id  | what failed                                                                                                                                                                                                                        | root cause                                                                                                                                                                                                                                                                                      | promoted to §V?                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | R1/R3/T4's assumption that every Phase B–E route already writes `admin_audit_log` was false — `comments.ts`/`children.ts`/`attachments-reference.ts` wrote no audit entries at all (allowed or denied); only `transitions.ts` did. | The spec was drafted from the design doc's aspirational description of what Phase B–E "should" have logged, not verified against the actual merged route code.                                                                                                                                  | Yes — see §V's centralized-classification and per-route atomic-write invariants; future phases must grep for actual `writeAuditEntry` call sites, not assume from a route's existence that it audits.                                  |
| B2  | The admin route's `applicationName` resolution (join `admin_audit_log.actorId` → `api_keys.id`) returned null for every row, including from the already-open Phase E PR.                                                           | Every third-party route (transitions.ts included) wrote `actorId: actingPersonId` into `admin_audit_log` — the acting person, not the API key — despite the column's own doc comment stating `actorId`+`actorType` identifies the key and `actingPersonId` is the separate, real-person column. | Yes — added as an explicit invariant: `admin_audit_log.actorId` for `actorType: "api_key"` rows must be the key id (parsed from `auth.userId`'s `apikey:<id>` prefix via the new `apiKeyIdFromUserId` helper), never `actingPersonId`. |

---

_spec is source of truth — update as decisions are made_
