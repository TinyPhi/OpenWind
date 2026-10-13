# 2026-10-13 — PR #842 review round 3: one-time handover fetch and small UI fixes

**Session type:** Review fixes
**Spec:** `docs/specs/multi-org-sandbox.md` R5 (provisioning progress + one-time handover), T17
**Branch:** `feat/sandbox-13-platform-admin-sandboxes-ui`

- **[B] blocker:** `CreateSandboxModal` fetched the one-time handover endpoint twice. The polling
  effect depended on `progress.status`, so it re-ran when the job completed and its unconditional
  first poll fetched `/handover` again. The reviewer's suggested early-return guard would have
  dropped the credentials, because that re-run's cleanup also cancels the in-flight poll that's
  fetching them. Instead, the effect now depends on `jobId` only. The poll that first sees
  `completed`/`failed` marks the job done (a ref) and clears the interval itself, and any poll
  already in flight drops out after its progress response. A new test keeps the progress mock
  answering `completed` and advances 10 s of poll intervals: exactly 3 calls, one `/handover`. It
  fails on the previous code.
- **[A]:** `SandboxRowActions` no longer passes the inert `busy={false}` / `busyLabel`.
  `ConfirmDeleteDialog`'s `busy` is now optional (default false), and its JSDoc documents the
  Radix `AlertDialogAction` synchronous-dismiss constraint. Existing callers behave the same.
- **[C]:** the trial-days input has `step={1}`, and create stays disabled unless it's a whole number
  from 1 to 365. It used to send `Number(x) || 14`, which let `1.5` through.
- **[D]:** the dashboard shows "Loading sandboxes…" until the first list fetch settles.
- **[E]:** a test pins the intentional silent session-fetch failure: no identity banner, no error,
  and the list still renders.
