# 2026-10-09 — sandbox delete (T15, multi-org sandbox Phase 3)

**Session type:** Feature implementation
**Spec:** `docs/specs/multi-org-sandbox.md` T15 (R8)
**Branch:** `feat/sandbox-10-delete`

- New `apps/worker/src/sandbox-delete-worker.ts`: acquires the `sandbox-lifecycle` advisory
  lock itself and holds it for the job's actual execution (applying T13's review-fix
  pattern from the start, rather than repeating the lock-lifetime bug Vijit caught on
  PR #832). Verifies the tenant is a sandbox, deletes its Zitadel org via `deleteOrg()` if
  one exists -- a failure there logs an error but does not block the rest, since
  `tenant-purge.ts` never deletes the `tenants` row (only marks it `purged`), so
  `zitadelOrgId` survives as a manual-cleanup breadcrumb regardless of outcome.
- Resolves T14's open item (b): instead of the real-tenant 30-day deletion delay
  (`scheduleTenantDeletion`, apps/api-only and not importable from apps/worker), the sandbox
  flow flips `tenants.status` to `deleted` with `deletionScheduledAt = now` directly and
  enqueues an immediate (`delay: 0`) job on the _existing_ `tenant-purge` queue --
  `tenantPurgeWorker` itself is completely unmodified; this reuses it rather than
  duplicating ~300 lines of purge logic or inventing a second delay model.
- New `POST /platform-admin/sandboxes/:tenantId/delete`: 404 for non-sandbox/missing
  tenant, a fast lock pre-check-and-release before enqueueing (409 if already held), then
  enqueues and awaits the delete job's completion (`waitUntilFinished`) before responding
  200 -- the response means "Zitadel org removed, OpenWind-side deletion initiated", not
  "full DB purge finished"; the purge itself proceeds asynchronously, same as real-tenant
  deletion already works today.
- New migration `0139_admin_audit_log_sandbox_delete_actions.sql` + `packages/audit`
  additions for `sandbox.delete_completed`/`.failed`, mirroring 0138/0136's pattern.
- While touching `apps/worker/src/queues.ts`, corrected a stale comment on
  `sandboxResetQueue` left over from before T13's review fix (it still claimed the API
  route holds the lock for the job's full duration).
- New tests: 8 worker unit tests (happy path, lock acquire/release, no-Zitadel-org case,
  Zitadel-deletion-failure-still-proceeds case, lock-held/tenant-not-found/not-a-sandbox/
  status-update-affects-zero-rows failure paths all audit+rethrow), 7 API route unit tests
  (404/409/200/503/500 paths, release-failure doesn't mask 200), 1 real-DB isolation test
  confirming the status flip to `deleted` with a near-immediate `deletionScheduledAt` and
  the `tenant-purge` queue enqueue call (Zitadel call and the purge queue's `add` are the
  only two things mocked, for reasons unrelated to DB isolation -- a real Zitadel network
  call and a real purge run have no place in this test).
- Confirmed pre-existing/unrelated via full-suite reruns: `entity_links` DB-drift isolation
  failures and local dev-DB test-data pollution in `record-resolved-mention`/
  `schedule-tick-worker`/`tenant-purge-plugin-data` (same recurring issues from prior
  sessions) -- none touch any file this PR changes.
