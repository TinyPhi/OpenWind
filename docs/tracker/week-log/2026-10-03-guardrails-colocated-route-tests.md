# 2026-10-03 — guardrails isolation check ignores colocated route tests (#762)

**Session type:** CI guardrail bug fix
**Branch:** `fix/762-guardrails-colocated-route-tests`

- **Fix:** `scripts/check-contribution-guardrails.sh` no longer counts a newly added
  `*.test.*` / `*.spec.*` file under `apps/api/src/routes/` as a new route. It uses the same
  test-file pattern as the tests-with-code check. A PR that only adds a colocated route test
  (PR #761) no longer needs `[skip-isolation-check]`.
- **Tests:** `scripts/test-claude-hooks.sh` runs the guardrails script in a throwaway git repo:
  - a colocated route test alone passes (failed before the fix);
  - a new route file plus its unit test, with no `tests/isolation/` change, still fails.
- **Local note:** five existing cases in `test-claude-hooks.sh` (protected paths and
  pass-approval) fail when `OPENWIND_OFFLIMITS` / `OPENWIND_AUTOPASS` are set in the shell, for
  example from `.claude/settings.local.json`. Run it with those unset. CI doesn't set them.
