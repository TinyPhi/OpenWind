# 2026-10-19 — Sandbox reset/delete timeout classification and list ordering (#994, #992 API half)

**Session type:** Follow-ups from the review of #991
**Branch:** `fix/PLAT-994-job-state-timeout`
**Issues:** #994, #992 (the dashboard half is in the admin-ui PR)

- **Done (#994).** `sandbox-reset.ts` and `sandbox-delete.ts` decided "the job timed out, it continues in the
  background" by matching `/timed out/i` on the error message. BullMQ's `waitUntilFinished` rejects both when its own
  wait expires and when the job fails, and in the failure case the error carries the worker's `failedReason`, which can
  also say "timed out" (a Zitadel fetch, for instance). Such a failure was reported as a 504 that told the operator not
  to retry, and logged at warn. The routes now ask the job (`classifyJobAfterWaitError`, `apps/api/src/lib/job-wait.ts`):
  failed is a 500, still queued or running is a 504, completed in the gap before the state was read is a 200, an
  unreadable state is a 500.
- **Done (#992, API half).** The list orders by `created_at DESC, id DESC`, so sandboxes created in the same instant keep
  a stable order, and a test asserts the `orderBy` arguments. The old test mocked `orderBy` to ignore its arguments, so
  removing the ordering would have passed.
- **Verified.** Helper tests; both route suites now carry the realistic BullMQ timeout message and the cases the old
  tests could not express; with the old regex routes four of them fail (two per route); list test fails with the
  tiebreaker removed or the direction reversed.
- **Deferred.** A cursor for the list (#992 keeps the cap-and-notice approach for now: the dashboard asks for the
  maximum page and says when it is truncated).
