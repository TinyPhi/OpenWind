# 2026-10-08 — sandbox reset (T13, multi-org sandbox Phase 3)

**Session type:** Feature implementation
**Spec:** `docs/specs/multi-org-sandbox.md` T13 (R7)
**Branch:** `feat/sandbox-09-reset`

- New `apps/worker/src/sandbox-reset-worker.ts`: `RESET_TENANT_TABLES` deletes only
  instance-level business data (entity instances, `workflow_events` history,
  `automation_executions`, notifications/outbox, labels/tags/alerts/access-requests,
  attachments/files, saved views, schedule executions, idempotency keys) for one tenant.
  Deliberately leaves module CONFIG (`entity_types`/`workflows`/`workflow_states`/
  `workflow_transitions`/`automation_rules`) and org/account identity (teams, on-call,
  `tenant_users`, `api_keys`, `installed_plugins`, `schedule_rules`, the `tenants` row
  itself) untouched — reset is a clean-demo-state operation, not a re-provision or an
  erasure. Reseed re-runs `seedAllModulesData` against `tenants.config.installed_modules`
  (T9's existing bookkeeping) — no module reinstall, since config was never wiped.
- Queued-but-unprocessed jobs for the tenant are cancelled across `automationQueue`,
  `slaQueue`, `dueDateQueue`, `dueDateApproachingQueue` (waiting/delayed only, never active)
  before reseeding, so nothing fires post-reset referencing wiped data. No existing
  "cancel jobs by tenantId" primitive existed in the codebase — new, scoped to these four
  queues per R7's literal "scheduled notifications, automation follow-ups" wording.
- `POST /platform-admin/sandboxes/:tenantId/reset` (new `sandbox-reset.ts` route): 404 for
  a non-sandbox/missing tenant, acquires the shared `sandbox-lifecycle` advisory lock (T22)
  before enqueueing, 409 if already held, enqueues to a new `sandbox-reset` BullMQ queue and
  awaits the job's completion (`job.waitUntilFinished`) before responding — deliberately no
  separate progress-polling endpoint (unlike T7/T8's provisioning flow): the API process
  holds the lock connection open across one request/response instead. Lock is always
  released in `finally`, release failures logged but never mask the response.
- New migration `0138_admin_audit_log_sandbox_reset_actions.sql` extends
  `admin_audit_log`'s CHECK constraint for `sandbox.reset_completed`/`.failed`, mirroring
  0136's pattern for provisioning; `packages/audit`'s `AuditAction` union and its two
  exhaustiveness maps (`outcome.ts`, `request-kind.ts`) updated in the same commit.
- New isolation test confirms the wipe-scope distinction for real: entity instances/
  workflow-event history/automation executions are gone after reset, while
  `workflow_states`/`workflow_transitions`/`workflows`/`entity_types`/`automation_rules`
  and the `tenants` row survive untouched.
- Found and fixed mid-implementation: local dev's `platform` database (patched first) and
  the isolation-test suite's actual target, `platform_test` (vitest config's fallback
  `DATABASE_URL`, since `.env.local` injection happens inside `@platform/config`, after
  `vitest.config.ts` has already evaluated its own `process.env` fallback) are two separate
  Postgres catalogs on the same container — the new migration had to be applied to both by
  hand locally. Not an issue in CI, which runs the full migration chain against a single
  fresh DB.
- Confirmed pre-existing/unrelated: `entity_links` DB-drift isolation-test failures (same
  as prior sessions) and `record-resolved-mention`/`schedule-tick-worker` isolation
  failures (shared local dev DB test-data pollution — fixed-tenant-id fixtures colliding
  with leftover rows from an earlier unclean run), reproduced in isolation from this PR's
  diff before being set aside.
