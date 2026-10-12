# 2026-10-12 — sandbox reset/delete workers never ran (PR #838 review, round 2)

**Session type:** Review fix
**Spec:** `docs/specs/multi-org-sandbox.md` T13, T15
**Branch:** `feat/sandbox-10-delete`

- PrabhuVijit's re-review of #838 confirmed round-1 findings A/B fixed, then found that
  `sandboxDeleteWorker` was never imported by `apps/worker/src/index.ts`. Checking it showed
  `sandboxResetWorker` (T13, already merged in #832) had the same gap on `upstream/main`: a
  BullMQ `Worker` only registers its processor when its module is loaded, so both queues
  filled and never drained. The API routes' 60s `waitUntilFinished` then timed out into
  `500`, meaning **sandbox Reset and Delete have never worked outside unit tests**. Unit and
  isolation tests call `processSandbox*Job` directly, which is why nothing caught it.
- Fixed: both workers are imported by the entry point and closed in `shutdown()`.
- New `apps/worker/src/worker-entry-wiring.test.ts` reads the worker sources and fails, naming
  the file, if any module that constructs a BullMQ `Worker` isn't imported by `index.ts`.
  Covers every worker, not just the sandbox ones. Verified it fails against the pre-fix
  `index.ts` with exactly `sandbox-delete-worker.ts` and `sandbox-reset-worker.ts`.
- Finding [2]: if the purge enqueue throws after the status flip, the tenant is left
  `deleted` with no purge, and the job (single attempt) can't recover it on a rerun. Added a
  test pinning that behaviour (rejects, status update happened, `sandbox.delete_failed`
  audited) and a comment at the call site naming the manual recovery (re-add
  `tenant-purge-<tenantId>`).
- Not changed: [3] timeout vs failure both returning `500` applies equally to the reset
  route, so it's proposed as one follow-up for both; [4] `invalidateTenantStatusCache` is
  synchronous `void`, so there is no promise to await.
