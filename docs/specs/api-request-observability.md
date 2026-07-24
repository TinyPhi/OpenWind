# API Request Observability (Phase 3D kickoff)

> Full API request audit trail across the platform, with bounded local retention and a
> pluggable outbound seam to an external observability/telemetry service — the same
> two-function separation pattern used for the in-app notification hub
> (`docs/specs/in-app-notification-hub.md`), applied to request-level logging instead of
> user-facing notifications.

status: draft
created: 2026-07-24
updated: 2026-07-24

---

## §G Goal

Every request handled by `apps/api` (and, once proven out, `apps/worker`'s job processing)
produces a queryable log entry — method, route, status, tenant/actor, duration, and error
detail on failure — visible in-platform for a bounded recent window, and durably archived by
an externally-owned observability service via a single, isolated handoff function whose
internals can change freely once that service's contract is settled.

Failures (5xx / unhandled exceptions) additionally continue to raise a `system.error`
in-app notification exactly as they do today — this feature does not replace that path,
it generalizes the log source behind it from "notification-outbound failures only" to
"any request failure."

Positioned as the first concrete work under **Phase 3D** (CLAUDE.md roadmap: "Observability +
compliance — OTel, Prometheus, GDPR"), which may run in parallel with 3A–3C. Phase 3 overall
has not formally started; this spec plus `.claude/context/phase-3-primer.md` (to be written
alongside the task plan) constitute the human-planning sign-off CLAUDE.md requires before 3A.

## §C Constraints

| constraint      | value                                                                                                                                                                                                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack           | Hono middleware (apps/api) → dedicated `request-log` BullMQ queue (NOT outbox_events — see §V) → worker (apps/worker) → Postgres table                                                                                                                                                                               |
| auth            | System-logs UI: `requireRole("admin")`, same as today's `/admin/system-logs`                                                                                                                                                                                                                                         |
| retention       | Bounded local window (default 30 days), auto-purge job; outbound service is the archive; un-archived rows purge on schedule regardless (data-loss accepted, surfaced via system.error — see R7)                                                                                                                      |
| captured fields | Metadata only — method, route pattern, statusCode, tenantId, userId, durationMs, occurredAt, errorMessage (on failure). **Never** request/response body, headers, query string, or cookies — no exceptions, not even a redaction denylist (denylists miss fields; the safer rule is "never capture the body at all") |
| perf budget     | Zero synchronous DB writes in the request path — capture + enqueue only, never await a persist before responding                                                                                                                                                                                                     |
| out of scope    | apps/worker job-level logging (phase 2 of this feature, not this pass); full APM/tracing UI; sampling/rate-limiting strategy (flag as an open question, not designed here); the external service's actual contract (isolated behind one handoff function, exactly like `dispatchOutbound`)                           |

## §I Interfaces

**Capture point:** a Hono middleware in `apps/api` wrapping every route, recording:
`requestId, method, path (route pattern, not raw path params), statusCode, tenantId, userId, durationMs, occurredAt, errorMessage (nullable, populated on 5xx/thrown errors)`.

**Write path — deliberately does NOT reuse `outbox_events`:**

Request-log volume (every single API call) is a different order of magnitude from
business-event volume (assignments, comments, access changes). Sharing the outbox table
risks its poller falling behind on real triggers during traffic spikes, and forces every
other outbox consumer to scan past request-log noise. A dedicated queue keeps the two
concerns fully isolated — same BullMQ infra, same worker process, different queue name.

```
request completes
  → middleware enqueues directly to a new `request-log` BullMQ queue (non-blocking,
    fire-and-forget — never awaited before responding to the caller)
  → apps/worker: request-log worker persists to a new `api_request_logs` table
    (tenant-scoped, RLS, bounded retention)
  → same worker enqueues the outbound telemetry handoff job
  → outbound worker calls `dispatchTelemetry(event)` — the single isolated seam,
    contract TBD, mirrors apps/worker/src/notification-outbound-worker.ts's
    dispatchOutbound exactly (bounded retries, no infinite loop back into itself —
    see §V, this bit already bit us once on the notification side)
```

**5xx/error path:** in addition to the row above, the existing `system.error` outbox event
still fires for unhandled exceptions/5xx responses, flowing through the existing
notification hub unchanged.

**Purge job:** a recurring worker job (mirrors `file-cleanup`'s existing recurring-job
pattern in apps/worker) deletes `api_request_logs` rows older than the retention window.

## §R Requirements

R1: Every request handled by apps/api produces exactly one log entry, without adding
synchronous latency to the request/response cycle.
✓ Load test shows p99 response time increase of less than 5ms (or 2%, whichever is larger)
with logging enabled vs disabled.
✓ A request whose logging-enqueue fails (e.g. Redis briefly down) still returns its normal
response to the caller — logging failure is never visible to the API consumer.
✓ Captured fields never include request/response body, headers, query string, or cookies —
verified by a test that posts a payload containing an obvious secret marker and asserts it
never appears in the persisted `api_request_logs` row.

R2: Admins can view recent request logs in a table (method, path, status, tenant/actor,
duration, timestamp, error detail if any), newest first, cursor-paginated.
✓ `/admin/system-logs`-equivalent page renders ≥100 entries without offset-pagination
drift under concurrent writes (same keyset-cursor requirement as the notification hub).
✓ Isolation test: a request logged under tenant A is never visible to an admin authenticated
against tenant B, via the API or a direct RLS-context query (mirrors this repo's mandatory
`tests/isolation/` coverage for every new tenant-scoped table).

R3: Local storage is bounded — entries older than the configured retention window are
deleted automatically, without manual intervention.
✓ A recurring purge job removes expired rows; a row inserted then artificially backdated
past the window disappears after the next purge run.

R4: The outbound telemetry handoff is a single, isolated function/module — nothing
upstream (capture, storage, retention, UI) needs to change when the external service's
real contract is finalized.
✓ The handoff function can be swapped/rewritten in isolation with no changes required to
the middleware, worker persistence logic, or the admin UI.

R5: A failing outbound handoff never recursively generates more log volume than the
original failure. (§V — this exact bug already occurred once on the notification-hub side
and is an explicit invariant now.)
✓ Outbound service down + N requests logged → exactly N failure records, no cascade.

R6: 5xx/unhandled-exception requests continue to raise `system.error` in-app notifications
exactly as today, unchanged.
✓ Existing notification-hub system.error tests continue passing unmodified.

R7: If the outbound telemetry service is unreachable for longer than the local retention
window, the affected rows are purged on schedule regardless (bounded local storage is
never sacrificed to wait for an unreliable external service) — but this data loss is never
silent.
✓ A row approaching purge age with no successful outbound delivery raises a `system.error`
notification (e.g. "N request-log entries purged without outbound archival") before
deletion, so an admin is always aware data was lost rather than discovering a silent gap.
✓ Successfully-archived rows purge on schedule with no notification — this alert fires only
for the unarchived case.

## §V Invariants

- A failure in the outbound telemetry handoff must never itself generate another loggable
  event of the same failure class — carried over directly from the notification hub's
  `system.error`-cascade incident (fixed in `notification-outbound-worker.ts`,
  2026-07-24). Any new outbound-handoff worker written for this feature must apply the
  same "terminal state only blocks re-processing" claim pattern from day one, not
  discover it the hard way again.
- Logging must never be able to fail a request. The capture/enqueue step is best-effort;
  any error there is caught and logged internally, never surfaced to the caller.
- Tenant isolation (RLS + explicit `WHERE tenant_id = ?`) applies to `api_request_logs`
  exactly as it does to every other tenant-scoped table — no exceptions for a
  observability/ops-facing table.

## §T Tasks

_Not yet broken into phases — pending `/spec-tasks`. Resolved via `/spec-review`
(2026-07-24): write path is a dedicated queue (not outbox_events), captured fields are
metadata-only (no body/headers), and un-archived rows purge on schedule with a
system.error alert rather than blocking retention indefinitely._

Remaining open questions before task planning:

1. **Sampling**: "every request" at scale may need sampling (e.g. log 100% of errors, 10% of
   2xx) rather than literally every row — deferred out of this spec's scope per §C, but
   flagging since it affects the retention/volume math directly. Not a blocker for a v1
   task plan, but should be revisited once real volume is observed.
2. **Retention window value**: 30 days proposed as a default — confirm before implementation.
3. **Which apps**: apps/api only for v1, or does apps/worker's own job processing need the
   same treatment in the same pass? §C scopes this to apps/api only for now.
4. **`.claude/context/phase-3-primer.md`**: per CLAUDE.md, Phase 3A needs this written before
   it starts; this spec's approval doesn't automatically greenlight 3A, only 3D.

## §B Bugs / Backprop Log

| id  | what failed                                                              | root cause                                                                                      | promoted to §V? |
| --- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | --------------- |
| B1  | Notification-outbound retries silently no-op'd instead of re-attempting  | De-dupe claim flipped `pending→attempted` before the actual call, blocking BullMQ's own retries | yes             |
| B2  | `system.error`'s own outbound failure cascaded into more `system.error`s | No check for "is this failure itself a system.error" before re-emitting                         | yes             |

---

_spec is source of truth — update as decisions are made. Run `/spec-review
api-request-observability` to stress-test before `/spec-tasks`._
