# 2026-10-09 — platform-admin sandbox list/create/reset/delete UI (T17 slice 2)

**Session type:** Feature implementation
**Spec:** `docs/specs/multi-org-sandbox.md` T17 (slice 2 of 2 — completes T17)
**Branch:** `feat/sandbox-13-platform-admin-sandboxes-ui`

- `/platform-admin/dashboard` now lists every sandbox (`GET /platform-admin/sandboxes`, T19)
  in a table with name, trial status, created date, and a manual refresh action, with an
  empty state when there are none.
- New `CreateSandboxModal`: collects org name + trial days, `POST`s
  `/platform-admin/sandboxes`, then polls `GET .../:jobId/progress` every 2s (mirroring
  R5's own "wait-screen polls a row" design) until the job lands on `completed` or
  `failed`. On completion it fetches `GET .../:jobId/handover` and shows a one-time
  "copy now" reveal (seeded accounts + default password) before closing and refreshing
  the list — structurally the same two-phase form/reveal shape as the existing
  `CreateApiKeyModal`.
- New `SandboxRowActions`: Reset and Delete buttons per row, each behind the shared
  `ConfirmDeleteDialog`.
- **Found and worked around mid-implementation**: `ConfirmDeleteDialog`'s `errorMessage`/
  `busy` props don't actually work for reporting an async failure — Radix's
  `AlertDialogAction` fires the dialog's `onOpenChange(false)` synchronously on click,
  before the async confirm handler has set `busy` to `true` in React state, so the
  dialog (and the stale `busy=false` closure captured by `onOpenChange`) dismisses
  itself immediately regardless of the request's outcome. This is a latent gap shared
  by the component's only other `errorMessage` consumer
  (`workflows/detail.tsx`'s "Delete workflow" dialog), not something introduced here —
  confirmed by writing a test against the intended behavior and watching it fail with
  the dialog already unmounted by the time the rejection arrived. Fixed for this
  feature by reporting failures through the existing global `showAlert` banner instead
  (the same pattern `api-keys/detail.tsx`'s revoke/rotate actions already use
  successfully) rather than relying on the dialog to stay open. Did not touch the shared
  `ConfirmDeleteDialog` component itself or the pre-existing "Delete workflow" caller —
  out of scope for this PR; worth a follow-up issue since it's a real, if minor, UX gap.
- A `409 LIFECYCLE_ACTION_IN_PROGRESS` response (route can legitimately take up to ~60s
  per `WAIT_FOR_RESET_TTL_MS`/`WAIT_FOR_DELETE_TTL_MS`) gets a specific "already in
  progress — try again shortly" message instead of a generic failure.
- New tests: 7 (dashboard list/refresh/empty-state/logout), 8 (row actions, including the
  corrected failure-reporting path and the in-flight-disables-buttons case), 7 (create
  modal: submit, validation, polling, handover reveal, done, failure, and provisioning
  failure). Full `@platform/admin-ui` suite: 69 files / 642 tests, all passing.
- T17 is now fully done across both slices.
