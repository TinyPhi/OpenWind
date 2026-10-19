# 2026-10-19 — Index for the workflow_events retention sweep (#777)

**Session type:** Implementation
**Branch:** `perf/PLAT-workflow-events-retention-index`
**Issues:** #777 (remaining index item)

- **Done.**
  - Migration `0151_workflow_events_tenant_created_at_idx` adds a `(tenant_id, created_at)` index
    on `workflow_events`. The retention sweep deletes with `tenant_id = $1 AND created_at < …` in
    batches, and the only tenant-leading index was `(tenant_id, instance_id)`, so each batch
    scanned the tenant's whole history. Schema file and journal updated; the journal test passes.
  - `workflow-events-retention-index.integration.test.ts` asserts the index and its columns
    against the migrated database.
- **Not done.** No measurement against a large table; the index is justified by the query shape,
  not by a benchmark. The index build takes a write lock on `workflow_events` while it runs
  (the migrator runs in a transaction, so no `CONCURRENTLY`); fine at current size, worth
  noting for a large hosted tenant.
- **Remaining on #777:** retention-class defaults are placeholders awaiting owner and counsel
  confirmation; per-entity hold is deferred.
