## 2026-08-18 — Issue #367 connector kill switch (ADR-009 Decision #9)

**Session type:** Feature (Phase 3A, Stage 2 runtime track)
**Branch:** `feat/PLAT-367-connector-kill-switch`
**Spec:** `docs/specs/connector-kill-switch.md` / `docs/specs/connector-kill-switch-tasks.md`

### Completed this session

- Migration `0063_connector_credentials_kill_switch.sql`: adds nullable `disabled_at`/`disabled_by`
  to `connector_credentials`, mirroring `api_keys.revoked_at`/`revoked_by`'s soft-revoke shape
  (migration 0053) rather than a bare boolean.
- `PATCH /connectors/:connectorId/disabled` (`apps/api/src/routes/connectors/`) — the first-ever
  connector-related API route, since no install flow exists yet (#369). Scoped to the caller's
  own tenant, writes an audit entry, 404s when no installation exists for that tenant.
- Enforcement at every place a connector installation is processed:
  - Inbound webhook gateway (`webhooks/handler.ts`) — a disabled installation folds into the
    SAME 401 branch as "not found"/"no signing secret" (no existence-oracle regression).
  - Outbound delivery worker (`connector-outbound-worker.ts`) — throws on disabled, reusing the
    existing attempt/retry/dead-letter machinery.
  - Polling scheduler/worker (#366) — scheduler excludes disabled installations from the desired
    repeatable-job set (filtered in SQL); worker skips (no throw) a race where an already-scheduled
    job fires after disabling.
- Isolation tests: extended `connector-credentials.isolation.test.ts` with a `disabled_at`/
  `disabled_by` RLS round-trip block; new `connector-kill-switch.isolation.test.ts` mounting the
  real Hono handler against real Postgres to prove the route's per-tenant scoping (mirrors
  `api-key-rotate.isolation.test.ts`).
- `packages/db/src/connector-credentials.ts`: new `connectorInstallationFilter(tenantId,
connectorId)` — the `(tenant_id, connector_id)` predicate every consumer needs, extracted after
  review found it copy-pasted verbatim across 6+ call sites (this table's identity shape has now
  grown three times: secrets → cursor_state → disabled_at, each addition previously requiring an
  N-site grep-and-patch).

### Review findings fixed pre-merge

Ran both `/review` (9 parallel angles) and `/security-review` on this diff — see below for what
each caught. All confirmed findings fixed; the security-reviewer's final pass re-verified the
whole diff against a live Postgres/Redis stack independently and found nothing further.

**Correctness (would have shipped a real bug):**

1. **Unredacted payload could reach dead-letter storage.** The kill-switch check in
   `connector-outbound-worker.ts` was originally inserted _before_ Step 4's PII/financial
   redaction. If a disabled installation's final attempt exhausted, the thrown error's dead-letter
   write would have persisted the RAW payload — directly contradicting that file's own documented
   guarantee ("never persists an unredacted value because the failure happened after redaction
   ran"). Fixed by moving the check to run immediately after Step 4, before Step 5 (SSRF)/Step 6
   (network call) — still skips the genuinely expensive/risky steps, but no longer skips the one
   step every subsequent throw's dead-letter path depends on.
2. **Missing installation row was treated as "enabled" (fail-open).** The original condition was
   `if (installation?.disabledAt)` — a deleted/never-installed row makes `installation` `undefined`,
   which is falsy, so processing would have continued. Fixed to `if (!installation ||
installation.disabledAt)`, matching `connector-poll-worker.ts`'s existing stance that a missing
   installation is at least as strong a stop signal as merely disabled.
3. **TOCTOU race in the route's audit trail.** The original `set-disabled.ts` did a separate
   `SELECT` (for the audit `beforeSnapshot`) then an `UPDATE` — two concurrent PATCH calls on the
   same row could each read the same stale prior state, corrupting the audit log's record of what
   actually happened. Fixed by collapsing to a single atomic `UPDATE … WHERE … AND
isNull/isNotNull(disabledAt) RETURNING`, mirroring `api-keys/delete.ts`'s existing soft-revoke
   idiom exactly — the WHERE guard proves the prior state without a separate read, and eliminates
   the race by construction. Side effect (accepted, tested): an idempotent re-disable now 404s
   (0 rows matched) rather than silently no-op-succeeding, same as `delete.ts`'s own "already
   revoked" behavior.

**Reuse/altitude (8 independent review angles converged on the same theme):** the
`(tenant_id, connector_id)` predicate was copy-pasted across the webhook gateway, outbound worker,
and poll worker (twice) — extracted into `connectorInstallationFilter()` in `packages/db`, used by
all four sites plus the route.

**Efficiency:** the poll scheduler was filtering disabled installations in JS after fetching every
row; moved to `WHERE isNull(disabledAt)` in SQL — fewer rows transferred, no wasted reconstruction
of rows that were unconditionally discarded.

### Deliberately not built / accepted tradeoffs

- **A disabled connector's queued outbound deliveries still retry through the full exponential
  backoff (up to ~25.6h) before dead-lettering**, rather than pausing indefinitely until
  re-enabled. Flagged by two independent review angles as a real tension with "re-enabling resumes
  exactly where things left off" (true for polling's `cursor_state`, not fully true for in-flight
  outbound deliveries under a long disable window). Building a distinct pause-and-resume mechanism
  for outbound retries is a bigger change than this issue's stated scope ("checked before
  processing") — accepted as a known v1 limitation, reusing the existing attempt/retry/dead-letter
  machinery rather than inventing a second state machine, matching what the spec's §V invariants
  already commit to.
- **No caching of the outbound worker's per-attempt `disabledAt` check.** Adds one DB round-trip
  per delivery attempt (same order of cost as the pre-existing `validateActiveTenant` check on the
  same code path) — accepted rather than adding cache-invalidation complexity for what's expected
  to be a rare (disabled) case.
- **Idempotent re-disable/re-enable returns 404, not a no-op 200.** Explicit, tested tradeoff (see
  finding #3 above) — an on-call engineer double-clicking "disable" during an incident sees "not
  installed" rather than a silent success. Matches existing codebase precedent exactly
  (`api-keys/delete.ts`).
- **No GET endpoint to read current disabled status.** Deferred to #369's marketplace UI, which is
  the first consumer that will need to display it.
- Everything #366 already documented as accepted (registry-lookup-by-wrong-id systemic pattern,
  unbatched cross-tenant scheduler scan) is unchanged by this issue.

### Verification

- pnpm typecheck: PASS
- pnpm lint: PASS
- pnpm test: PASS (922 tests in apps/api alone, full monorepo green)
- pnpm test:isolation: PASS (341 tests in apps/api, 4 in apps/worker)
- `/review`: 9 parallel angles, findings triaged above (3 correctness fixes, 1 cross-cutting
  reuse extraction, 1 efficiency fix; remaining findings accepted as documented tradeoffs)
- `/security-review`: independently re-verified the full diff against a live Postgres/Redis
  stack after the above fixes landed — no further findings
