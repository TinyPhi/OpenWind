#!/usr/bin/env bash
# check-contribution-guardrails.sh — PR-level enforcement of the gate-equivalent rules,
# for ALL contributors (this runs in CI, not just inside Claude Code). It is the layer that
# actually binds everyone — the .claude hooks are the same checks earlier, as fast feedback.
#
# Usage: check-contribution-guardrails.sh <base-sha>
# Escapes (put the token in the PR title): [skip-tests-check]  [skip-isolation-check]
set -uo pipefail
BASE="${1:?usage: check-contribution-guardrails.sh <base-sha>}"
TITLE="${PR_TITLE:-}"
cd "$(git rev-parse --show-toplevel)" || exit 1

CHANGED=$(git diff --name-only --diff-filter=AM "$BASE"...HEAD)
ADDED=$(git diff --name-only --diff-filter=A "$BASE"...HEAD)
fail=0
bad() {
  echo "  ✗ $1"
  fail=1
}
good() { echo "  ✓ $1"; }

echo "== config-first (ADR-004): no TypeScript under modules/ =="
MOD_TS=$(printf '%s\n' "$ADDED" | grep -E '^modules/.*\.(ts|tsx)$' || true)
if [ -n "$MOD_TS" ]; then
  bad "TypeScript added under modules/ — modules are seed SQL only:"
  printf '%s\n' "$MOD_TS" | sed 's/^/        /'
else
  good "no .ts/.tsx added under modules/"
fi

echo "== tests-with-code: source changes ship with tests =="
SRC=$(printf '%s\n' "$CHANGED" | grep -E '^(apps|packages)/.*\.(ts|tsx)$' | grep -vE '\.(test|spec)\.[tj]sx?$|(^|/)(tests?|__tests__)/' || true)
TST=$(printf '%s\n' "$CHANGED" | grep -E '\.(test|spec)\.[tj]sx?$|(^|/)(tests?|__tests__)/' || true)
if [ -n "$SRC" ] && [ -z "$TST" ]; then
  if printf '%s' "$TITLE" | grep -q '\[skip-tests-check\]'; then
    good "source changed without tests — waived via [skip-tests-check]"
  else
    bad "source changed but no test files changed. Add tests, or put [skip-tests-check] in the PR title with a reason:"
    printf '%s\n' "$SRC" | sed 's/^/        /'
  fi
else
  good "tests present (or no source change)"
fi

echo "== isolation tests for new tables / routes =="
NEW_TABLE=$(git diff "$BASE"...HEAD -- 'packages/db/**' | grep -iE '^\+.*CREATE TABLE' || true)
NEW_ROUTE=$(printf '%s\n' "$ADDED" | grep -E '^apps/api/src/routes/.*\.ts$' || true)
ISO=$(printf '%s\n' "$CHANGED" | grep -E '(^|/)tests/isolation/' || true)
if { [ -n "$NEW_TABLE" ] || [ -n "$NEW_ROUTE" ]; } && [ -z "$ISO" ]; then
  if printf '%s' "$TITLE" | grep -q '\[skip-isolation-check\]'; then
    good "new table/route without isolation test — waived via [skip-isolation-check]"
  else
    bad "new table or route added but no tests/isolation/ change. Add isolation tests, or put [skip-isolation-check] in the PR title."
  fi
else
  good "isolation tests present (or no new table/route)"
fi

echo ""
if [ "$fail" -eq 0 ]; then
  echo "contribution guardrails: PASS"
else
  echo "contribution guardrails: FAIL — see above. These mirror the .claude gate rules and bind every contributor."
  exit 1
fi
