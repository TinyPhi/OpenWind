## 2026-08-18 — Issue #366 connector polling scheduler (ADR-009 Decision #7)

**Session type:** Feature (Phase 3A, Stage 2 runtime track)
**Branch:** `feat/PLAT-366-connector-poll-scheduler`
**Spec:** `docs/specs/connector-polling-scheduler.md` / `docs/specs/connector-polling-scheduler-tasks.md`

### Completed this session

- `apps/worker/src/queues.ts`: added `connectorPollQueue` (`connector-poll`, attempts:3/exponential
  1s — matching `connectorInboundQueue`'s internal-processing-failure rationale, not
  `connectorOutboundQueue`'s hours-long third-party-retry tail).
- `apps/worker/src/connector-poll-scheduler.ts`: a `setInterval` reconcile ticker (default 5 min,
  mirrors `sla-scheduler.ts`'s overlap-guarded shape) — no install/uninstall API route exists yet
  (#369), so this is the _only_ place a `connector-poll` BullMQ repeatable job is created or
  removed. Every tick: list all `connector_credentials` rows cross-tenant, resolve each
  installation's `ConnectorDefinition` from the in-process registry, keep only ones with a
  `type: "polling"` trigger, diff against `connectorPollQueue.getRepeatableJobs()`, add/remove/
  update accordingly.
- `apps/worker/src/connector-poll-worker.ts`: consumes `connector-poll` jobs — the first real
  production caller of `createConnectorContext()` and a polling `TriggerDefinition.fetch()`.
  Builds `ConnectorContext`, calls `fetch(ctx, cursor)`, forwards every returned event onto the
  existing `connectorInboundQueue` (same job-data shape the inbound webhook gateway already uses),
  advances `connector_credentials.cursor_state` only after all events are durably enqueued.
- Wired both into `apps/worker/src/index.ts`'s start/shutdown lists.
- Isolation test coverage: extended `connector-credentials.isolation.test.ts` with `cursor_state`
  round-trip + RLS-denial coverage (no new table/migration — `cursor_state` already existed from
  migration 0056/issue #363).
- Unit tests: `connector-poll-scheduler.test.ts` (diff logic), `connector-poll-worker.test.ts`
  (fetch→enqueue→cursor-advance flow, skip-not-throw on stale state).

### Review findings fixed pre-merge

`/review` caught two correctness bugs that would have made polling silently non-functional:

1. **Repeatable-job matching used `job.id`, which BullMQ never populates** for jobs added via the
   normal `queue.add({repeat})` path (`getRepeatableJobs()` only returns `key`/`name`/`every`/etc.
   — confirmed against bullmq 5.76.8's `Repeat.getRepeatableData()`). Every tick was deleting and
   re-adding every job, anchoring its next-fire time to the current tick — for any
   `intervalMinutes` >= the 5-minute reconcile interval, the job would never actually reach its
   due time before being replaced again. Fixed by passing an explicit `repeat: { key: pollJobId }`
   (BullMQ's own "custom repeatable key ... for easier retrieval" feature) instead of relying on
   `jobId`, so `job.key` returned by `getRepeatableJobs()` is exactly the desired-map's key with no
   decode step needed.
2. **Per-event dedup id was derived from `(tenantId, connectorId, cursor, index)`.** A connector
   whose `fetch()` legitimately never returns `nextCursor` (in-spec — e.g. a "list current open
   items" poller with no monotonic cursor concept) would re-derive identical ids every scheduled
   poll, and BullMQ silently no-ops a duplicate-`jobId` `add()` — new events would vanish with no
   error. Fixed by deriving the id from `(this poll job's own BullMQ job.id, event index)` instead:
   stable across BullMQ's own `attempts:3` retry of one scheduled occurrence, but distinct for
   every subsequent occurrence regardless of whether the cursor advanced.

### Security-review findings fixed pre-merge

`/security-review` found the reconcile logic still had one unfixed instance of the SAME
root defect the two `/review` findings above address, plus two hardening gaps:

3. **The reconcile loop unconditionally called `.add()` for every desired job on every tick,
   even ones already correct.** Confirmed against bullmq 5.76.8's `addRepeatableJob-2.lua`:
   "If we are overriding a repeatable job we must delete the delayed job for the next
   iteration" — `queue.add()` for a repeatable job always runs with `override: true`, which
   cancels and re-derives the pending delayed job's next-fire time from _now_ on every call,
   regardless of whether `repeat.key`/`every` changed. This would have reproduced the exact
   "never fires" bug from finding 1 via the add-side instead of the remove-side. Fixed by
   tracking which existing jobs already match desired state and skipping `.add()` for those —
   BullMQ's own repeat scheduling is left alone once correctly set.
4. **No floor on a connector's declared `intervalMinutes`.** `0` or a negative value would
   pass straight into `repeat.every`, producing a continuously-refiring job — a self-inflicted
   DoS against both this worker's own DB/Redis and the connector's third-party host. Fixed
   with a `MIN_INTERVAL_MINUTES = 1` floor in `buildDesiredJobs()`; a violating installation is
   logged and skipped rather than scheduled.
5. **`fetch()`'s return value had no size/count validation before reaching
   `connectorInboundQueue`.** Unlike `ActionDefinition.output` (Zod schema + `maxOutputBytes`
   enforced at the outbound boundary), `TriggerDefinition.polling` has neither — and
   `connectorInboundQueue` has no consumer or TTL yet (pre-existing, documented gap from #364,
   not introduced here), making an unbounded producer worse than merely noisy. Fixed with a
   flat `MAX_EVENTS_PER_POLL = 1000` count cap and a per-event `DEFAULT_MAX_OUTPUT_BYTES`
   (256KB, reusing connector-sdk's existing outbound-boundary constant for consistency) size
   cap in `connector-poll-worker.ts` — either violation throws, failing the poll job outright
   rather than silently truncating or dropping events.

### Deliberately not built (other issues' scope)

- Kill switch / disabled flag — #367.
- Real connector definitions (email/WhatsApp) — #368. Zero connectors are registered in the
  in-process registry today, so the scheduler's registry-lookup skip path is the only path
  exercised in production until #368 lands.
- Install/uninstall API route — #369.
- A consumer `Worker` for `connectorInboundQueue` — still nobody's built one; this issue is a
  second _producer_ onto it, same as the inbound webhook gateway (#364).

### Known, accepted (not fixed this session)

- `getConnectorDefinition(row.connectorId)` looks up the registry by `connectorCredentials`'s
  `connectorId` (a DB-generated UUID FK to `connector_definitions.id`), while the registry is
  keyed by `ConnectorDefinition.meta.id` (an arbitrary string connector authors choose) — nothing
  in the codebase yet guarantees these are the same value. This is a systemic, already-merged
  pattern (`connector-outbound-worker.ts`, `apps/api/src/routes/webhooks/handler.ts` both do the
  same lookup) that this diff inherits rather than introduces; fixing it is a cross-cutting change
  belonging to whichever issue defines the connector-registration convention (likely #368), not
  this one.
- The reconcile tick's `db.select().from(connectorCredentials)` is an unbounded, unbatched
  cross-tenant scan (unlike `sla-scheduler.ts`'s `BATCH_SIZE=50` claim-pattern) — accepted for v1
  given the realistic installation count (single digits pre-#369's marketplace), revisit if/when
  installation volume grows.

### Verification

- pnpm typecheck: PASS
- pnpm lint: PASS
- pnpm test: PASS (176 tests in apps/worker, full monorepo green)
- pnpm test:isolation: PASS (336 tests)
- `/review`: 2 confirmed correctness findings, both fixed
- `/security-review`: 1 HIGH + 1 MEDIUM + 1 LOW/MEDIUM finding, all addressed (the LOW/MEDIUM
  finding's "unconditional re-add" half turned out to be a correctness bug on closer inspection
  against BullMQ's own Lua scripts, not just an efficiency nit — see above); credential handling,
  tenant isolation on the worker's own queries, and the new `cursor_state` isolation test coverage
  were all confirmed clean by the same review.
