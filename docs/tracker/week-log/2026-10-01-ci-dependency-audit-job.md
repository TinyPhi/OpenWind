# 2026-10-01 — Dependency audit split into its own CI job

**Session type:** CI change (human-directed; follow-up to #748)
**Branch:** `fix/ci-audit-job-split`

- Problem: the "Audit dependencies" step lived in the `security` (CodeQL) job and blocked every
  PR. An advisory published after a branch was cut failed every open PR at once, even PRs that
  touch no dependency (#710, #720, #748 in three days).
- `.github/workflows/ci.yml`:
  - New `dependency-audit` job (checkout + pnpm + node only; `pnpm audit` reads the lockfile, so
    no install/build). Blocking on push, schedule, and PRs whose diff touches `**/package.json`,
    `pnpm-lock.yaml` or `pnpm-workspace.yaml` (new `deps` output on the `changes` job). On other
    PRs the step is `continue-on-error` and emits a `::warning::` instead.
  - If `changes` fails, the audit stays blocking.
  - New daily cron `0 4 * * *` so `main` goes red the day an advisory lands. The `security` job
    now matches only the weekly cron (`0 3 * * 1`), so CodeQL stays weekly.
  - `ci-complete` now needs `dependency-audit`.
- Dependabot security updates were enabled on the repo the same day (repo setting).
- Verified: `actionlint` clean; YAML parses with the expected jobs, schedules and `needs`.
