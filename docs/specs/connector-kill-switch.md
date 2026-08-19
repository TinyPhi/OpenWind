# Connector Kill Switch

> A live-flippable, non-destructive disable for a specific (tenantId, connectorId) installation — an operational off-switch for incident response, distinct from install/uninstall.

status: draft
created: 2026-08-18
updated: 2026-08-18

---

## §G Goal

- An admin (of the tenant that owns the installation) can flip a `connector_credentials` row to "disabled" and back, live, with no restart.
- Once disabled: the inbound webhook gateway rejects deliveries for that installation exactly as if it didn't exist (no existence oracle regression); the outbound delivery worker skips sending and records why; the polling scheduler/worker (issue #366, now shipped) stop polling it.
- Disabling never deletes or mutates any other data — `secrets`/`cursor_state` are untouched, so re-enabling resumes exactly where things left off.

## §C Constraints

| constraint     | value                                                                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| stack          | Drizzle/Postgres migration, Hono route, existing BullMQ workers from #362/#364/#365/#366                                                                                                                                       |
| auth           | `requireAuth() + requireRole("admin")`, scoped to the caller's own `auth.tenantId` — no cross-tenant path exists (mirrors `api-keys/rotate.ts`'s convention)                                                                   |
| pattern reused | `docs/specs/outbound-notifications-kill-switch.md`'s live-flip precedent, extended from a single global boolean to a per-`(tenantId, connectorId)` timestamp — genuinely new work per that spec's own note, not a direct reuse |
| out of scope   | install/uninstall (that's the existing, still-unbuilt install flow — #369), marketplace UI (#369 "surfaces" this route's control, doesn't rebuild it), a GET/list endpoint (covered by #369's browse view)                     |

## §I Interfaces

```sql
-- migration 00NN — additive, nullable, no existing read/write path breaks
ALTER TABLE connector_credentials ADD COLUMN disabled_at timestamptz;
ALTER TABLE connector_credentials ADD COLUMN disabled_by text;
```

```ts
// packages/db/src/schema/platform.ts — connectorCredentials additions
disabledAt: timestamp("disabled_at", { withTimezone: true }),
disabledBy: text("disabled_by"),
```

```
PATCH /connectors/:connectorId/disabled
  body: { disabled: boolean }
  -> { data: { connectorId, disabled, disabledAt, disabledBy } }
  404 if the caller's tenant has no installation of :connectorId
```

## §R Requirements

R1: An admin can disable and re-enable their own tenant's connector installation live.
✓ `PATCH /connectors/:connectorId/disabled` with `{disabled: true}` sets `disabled_at = now()`, `disabled_by = callerUserId`.
✓ `{disabled: false}` clears both back to `NULL`.
✓ 404 (not 403) when the caller's tenant has no row for that connector — no existence-leak beyond what any other tenant-scoped route already reveals.
✓ Writes an audit entry (`resourceType: "connector_installation"`, `action: "updated"`) with before/after `{disabled}` snapshots.

R2: The inbound webhook gateway treats a disabled installation exactly like a nonexistent one.
✓ A signed webhook for a disabled installation gets the same generic 401 as an unknown tenant/connector or a bad signature — same dummy-decrypt timing cost paid, no distinguishable latency (preserves ADR-009 Decision #3's no-existence-oracle property, now also covering "is this disabled").

R3: The outbound delivery worker does not deliver for a disabled installation, and this is visible in the existing attempt/dead-letter machinery — no new state machine.
✓ A queued delivery job for a disabled installation records a `connector_delivery_attempts` row with a "disabled" error message and follows the SAME retry/backoff/dead-letter path any other failure does (reusing `processJob`'s existing catch block).
✓ Re-enabling before the job's attempts are exhausted lets a subsequent retry deliver normally — disabling never cancels or drops an already-queued job.

R4: The connector polling scheduler/worker (#366) do not poll a disabled installation.
✓ `connector-poll-scheduler.ts`'s reconcile tick excludes a disabled installation from the desired set — no repeatable job is scheduled for it (not merely skipped at execution time).
✓ `connector-poll-worker.ts` also skips (no throw) if a job that was already scheduled fires after the installation became disabled mid-cycle — same "race against the next reconcile tick" pattern already used for missing-installation/missing-trigger.

## §V Invariants

- `disabled_at`/`disabled_by` are the ONLY fields this feature touches — `secrets` and `cursor_state` are never read differently or mutated by a disable/enable toggle.
- Every enforcement point added by this issue reuses that call site's EXISTING failure-handling path (generic 401 + dummy decrypt for the webhook gateway; the attempt/retry/dead-letter machinery for outbound delivery; the skip-not-throw pattern for polling) — no new response shapes, no new terminal states invented.
- The kill switch is checked at delivery/processing time, not just at enqueue time — an already-queued outbound job for a since-disabled installation must still be blocked when it's actually processed.

## §T Tasks

| id  | task                                                                                                                                                                                                                                                                                                           | phase | status | depends     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ----------- |
| T1  | Migration: `disabled_at`/`disabled_by` nullable columns on `connector_credentials` + Drizzle schema update                                                                                                                                                                                                     | 1     | todo   | —           |
| T2  | `PATCH /connectors/:connectorId/disabled` route (`apps/api/src/routes/connectors/set-disabled.ts` + `index.ts`, registered in `app.ts`) + audit entry                                                                                                                                                          | 1     | todo   | T1          |
| T3  | Webhook gateway (`apps/api/src/routes/webhooks/handler.ts`): select `disabledAt`, fold into the existing not-found/no-secret branch                                                                                                                                                                            | 2     | todo   | T1          |
| T4  | Outbound delivery worker (`apps/worker/src/connector-outbound-worker.ts`): query `connectorCredentials.disabledAt` early in `processJob`, throw a descriptive error if set (flows into existing catch/retry/dead-letter)                                                                                       | 2     | todo   | T1          |
| T5  | Polling scheduler (`connector-poll-scheduler.ts`): exclude disabled installations from the desired set. Polling worker (`connector-poll-worker.ts`): select `disabledAt` alongside the existing installation lookup, skip (no throw) if set                                                                    | 2     | todo   | T1          |
| T6  | Isolation tests: extend `connector-credentials.isolation.test.ts` with `disabled_at`/`disabled_by` round-trip + RLS coverage; new `connector-kill-switch.isolation.test.ts` proving the route's own tenant-scoping (real Hono handler + real Postgres, mirroring `api-key-rotate.isolation.test.ts`'s pattern) | 3     | todo   | T1,T2       |
| T7  | Unit tests: `set-disabled.test.ts` (mocked DB — 404/audit/happy-path), extend `connector-outbound-worker.test.ts`, `connector-poll-scheduler.test.ts`/`connector-poll-worker.test.ts`, and `webhooks/handler.test.ts` for the disabled branch in each                                                          | 3     | todo   | T2,T3,T4,T5 |

phase gate: all unit + integration tests pass before advancing to next phase

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |

---

_spec is source of truth — update as decisions are made_
