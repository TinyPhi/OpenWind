## 2026-10-31 — 3H: rewrite the #691 vendor-approval live walk-through runbook

### Done

- Added `docs/runbooks/vendor-approval-walkthrough.md`, replacing the 2026-10-02 walk-through comment on #691.
  Rewritten against current code: admin is no longer on the review transitions (#1009), the admin-ui has a
  State dropdown rather than an action bar, bootstrap has no manual PAT step, and `delivered_at` on
  `workflow.sla_scheduled` rows means "enqueued", not "processed".
- Recorded two code-reading findings in the runbook's gaps section (not fixed, not run live):
  admin-ui offers every transition out of the current state to every agent (server still refuses), and a
  non-admin workflow admin cannot clear an actor rule but can add an unguarded parallel transition or widen
  `allowed_roles`.
- Linked the runbook from `docs/runbooks/README.md`.

### Verification

- pnpm typecheck: N/A — docs-only
- pnpm lint: N/A — docs-only
- pnpm test: N/A — docs-only
- pnpm test:isolation: N/A — docs-only

### Next

- Run the walk-through on a live stack and record T12 PASS/FAIL in `docs/specs/vendor-approval.md` §B.
- File issues for the two gaps.
