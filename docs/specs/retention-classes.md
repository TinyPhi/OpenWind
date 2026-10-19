# Retention classes and tenant-context sweeps

**Status:** Implemented (hardening PR 4). **Related:** ADR-015 (retention/erasure sweeps), ADR-001.

## Problem

The daily retention sweep (`apps/worker/src/retention-archival.ts`) and the usage-metering sweep
issued their queries on the plain `db` connection. Under compose that connection is `app_user`,
and with no `app.tenant_id` set RLS hid every row, so the retention sweep matched and deleted
nothing. It also treated every `workflow_events` row alike, so switching it on naively would have
deleted case history by age alone.

## Behaviour

1. **Tenant context.** Every per-tenant statement runs inside `withTenantContext`, with the explicit
   `tenant_id` filter kept alongside RLS (security rule 1). The usage-metering sweep does the same
   for its storage read and daily upserts.
2. **Classes of `workflow_events`**, decided from structural columns only:
   - _evidence_ — creation (`from_state IS NULL`), a real state change (`from_state <> to_state`) or a
     typed same-state event other than a comment.
     Never swept while the case exists and is open (non-terminal state with a workflow, not
     soft-deleted) or was updated within the evidence window. Swept only after the evidence window.
   - _comment_ — `from_state = to_state` and `metadata->>'type' = 'comment'`.
   - _noise_ — a same-state event with no `metadata.type`. Same-state events with any other type
     (record updates, access grants, attachment and severity records) are evidence.
     The class is read from the state columns and `metadata.type` at sweep time.
3. **Windows**, in days. Defaults come from validated env settings and can be overridden per tenant
   in `tenants.config`. An invalid override falls back to the default for that field only. A config that is not an object is treated as a hold.

   | Class (and the non-event tables listed in item 7, for noise) | Env default                    | Tenant override           |
   | ------------------------------------------------------------ | ------------------------------ | ------------------------- |
   | noise, delivered outbox rows, usage rows, item 7 tables      | `RETENTION_DEFAULT_DAYS` 90    | `retention_days`          |
   | comment                                                      | `RETENTION_COMMENT_DAYS` 365   | `retention_comment_days`  |
   | evidence                                                     | `RETENTION_EVIDENCE_DAYS` 2555 | `retention_evidence_days` |

   Bounds: noise 7–3650, comment 30–3650, evidence 365–7300. **The comment and evidence defaults are
   placeholders for the owner and counsel to confirm.**

4. **Hold.** `tenants.config.retention_hold: true` skips every sweep for that tenant. A malformed
   `retention_hold` value is treated as a hold (fail closed). A per-entity hold is deferred, and a hold set while a sweep is running applies from the next run.
5. **Batching.** Deletes run in batches (`RETENTION_BATCH_SIZE`, default 5000), each in its own short
   transaction, with `RETENTION_BATCH_PAUSE_MS` (default 50) between batches.
6. **Visibility.** Rows deleted are counted in `openwind_retention_deleted_rows_total{table,class}`,
   and each tenant's per-table result is logged, so a sweep that deletes nothing shows up.

7. **Operational tables (issue #636).** The sweep also deletes, per tenant and under the noise
   window, rows past it from `notification_recipients` then `notifications` (children first;
   recipients are matched through the parent's `created_at`), `connector_delivery_attempts` and
   `dead_letter_events` (by `created_at`), and `idempotency_keys` (by `expires_at`, so the window runs
   from expiry, not creation). They use the same hold, batching and
   `openwind_retention_deleted_rows_total{table,class="noise"}` conventions. `app_user` already holds
   DELETE on all five (migrations 0022, 0040, 0057, 0082), so no migration was needed. **Out of scope:**
   `schedule_executions` is append-only; sweeping it needs a `GRANT DELETE` migration and a human
   ADR-017 amendment, so it is not touched.

## Structure

`retention-archival.ts` orchestrates (lock, tenant list, trial and hold checks).
`retention-policy.ts` resolves a tenant's policy. `retention-sweep.ts` owns the SQL, so a later
change to how the event log is maintained swaps one module.

## Tests

- `retention-policy.test.ts`, `retention-archival.test.ts`, config tests — unit.
- `tests/isolation/retention-sweep.isolation.test.ts` — real Postgres as `app_user`: deletion by
  class, open and recently-active evidence kept, hold honoured, another tenant untouched, default
  windows keep old evidence. Also covers the item 7 tables: old rows deleted, recent rows kept,
  held and other tenants untouched.
- `apps/worker/src/retention-sweep.test.ts` — unit: delete order (recipients before notifications),
  tenant filter and window on every new statement, hold is a no-op.
