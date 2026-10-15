# 2026-10-15 — PR #945 independent-review follow-ups

**Branch:** `feat/PLAT-hardening-retention-classes`

- **Done.** The retention sweep lock holds a unique token and is released by compare-and-delete, so a sweep that
  outlives the TTL no longer deletes the lock a later instance took. Provisioning config now types
  `retention_comment_days`, `retention_evidence_days` and `retention_hold` with the sweep policy bounds.
- **Deferred.** The lock still has a fixed one-hour TTL with no renewal, so a very long sweep can overlap with a
  second one (extra load, deletes are idempotent). The `(tenant_id, created_at)` index on `workflow_events` waits for
  the 0145 and 0146 migrations to merge. Comments on open cases are still deleted by age; that is a counsel decision.
  `retention_days` keeps its provisioning minimum of 1 against the sweep's 7, to avoid breaking callers.
