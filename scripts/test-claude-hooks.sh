#!/usr/bin/env bash
# test-claude-hooks.sh — unit tests for the Claude Code guardrail hooks.
# Runs in CI (contribution-guardrails workflow) and locally. Feeds each hook sample
# stdin and asserts its block (exit 2) / allow (exit 0) behaviour, so a PR that breaks
# a gate's logic fails CI instead of silently weakening enforcement.
# No network. Side effects (a temp file + .claude/state) are cleaned up on exit.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
H=.claude/hooks
PASS=0
FAIL=0
TMP=.claude/_hooktest_tmp.ts

cleanup() {
  git reset -q -- "$TMP" 2>/dev/null || true
  rm -f "$TMP"
  rm -rf .claude/state
}
trap cleanup EXIT

ck() { # ck <expected> <label> <got>
  if [ "$3" = "$1" ]; then echo "  ok    $2"; PASS=$((PASS + 1)); else echo "  FAIL  $2 (expected $1, got $3)"; FAIL=$((FAIL + 1)); fi
}
hook() { printf '%s' "$2" | "$H/$1" >/dev/null 2>&1; echo $?; }

echo "syntax:"
for f in "$H"/*.sh; do bash -n "$f" && echo "  ok    $f" || { echo "  FAIL  $f"; FAIL=$((FAIL + 1)); }; done

echo "edit-gate (source-only, tests exempt):"
ck 0 "docs under packages/ not gated" "$(hook edit-gate.sh '{"tool_name":"Write","tool_input":{"file_path":"packages/db/README.md"}}')"
ck 2 ".ts under packages/ gated" "$(hook edit-gate.sh '{"tool_name":"Write","tool_input":{"file_path":"packages/db/x.ts"}}')"
ck 2 ".sql under modules/ gated" "$(hook edit-gate.sh '{"tool_name":"Write","tool_input":{"file_path":"modules/crm/002.sql"}}')"
ck 0 "test files exempt" "$(hook edit-gate.sh '{"tool_name":"Write","tool_input":{"file_path":"packages/db/foo.test.ts"}}')"
ck 0 "outside source roots ignored" "$(hook edit-gate.sh '{"tool_name":"Edit","tool_input":{"file_path":"docs/x.md"}}')"

echo "commit-gate (bypass anchoring):"
ck 2 "SHIP_BYPASS token in -m message does NOT bypass" "$(hook commit-gate.sh '{"tool_name":"Bash","tool_input":{"command":"git commit -m \"SHIP_BYPASS=1 x\""}}')"
ck 0 "SHIP_BYPASS prefix bypasses (standalone)" "$(hook commit-gate.sh '{"tool_name":"Bash","tool_input":{"command":"SHIP_BYPASS=1 git commit -m x"}}')"
ck 0 "SHIP_BYPASS prefix bypasses (mid-compound)" "$(hook commit-gate.sh '{"tool_name":"Bash","tool_input":{"command":"cd /tmp && SHIP_BYPASS=1 git commit -m x"}}')"
ck 0 "non-commit git command ignored" "$(hook commit-gate.sh '{"tool_name":"Bash","tool_input":{"command":"git status"}}')"

echo "destructive-guard:"
ck 2 "rm -rf / blocked" "$(hook destructive-guard.sh '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}')"
ck 2 "rm --recursive --force ~ blocked (long form)" "$(hook destructive-guard.sh '{"tool_name":"Bash","tool_input":{"command":"rm --recursive --force ~/data"}}')"
ck 0 "rm -rf node_modules allowed" "$(hook destructive-guard.sh '{"tool_name":"Bash","tool_input":{"command":"rm -rf node_modules"}}')"
ck 2 "git push --force blocked" "$(hook destructive-guard.sh '{"tool_name":"Bash","tool_input":{"command":"git push --force"}}')"
ck 2 "git commit --no-verify blocked" "$(hook destructive-guard.sh '{"tool_name":"Bash","tool_input":{"command":"git commit --no-verify -m x"}}')"
ck 2 "git commit -anm combined flag blocked" "$(hook destructive-guard.sh '{"tool_name":"Bash","tool_input":{"command":"git commit -anm wip"}}')"

echo "protected-paths:"
ck 2 "modules/*.ts blocked" "$(hook protected-paths.sh '{"tool_name":"Write","tool_input":{"file_path":"modules/crm/x.ts"}}')"
ck 2 ".env* blocked" "$(hook protected-paths.sh '{"tool_name":"Write","tool_input":{"file_path":".env.local"}}')"
ck 2 "ADR files blocked" "$(hook protected-paths.sh '{"tool_name":"Edit","tool_input":{"file_path":"docs/decisions/ADR-001-multitenancy.md"}}')"
ck 2 "any workflow file blocked" "$(hook protected-paths.sh '{"tool_name":"Write","tool_input":{"file_path":".github/workflows/deploy.yml"}}')"

echo "verify-stop (sentinel-gated):"
ck 0 "no claimed-done sentinel -> allows stop" "$(hook verify-stop.sh '{"hook_event_name":"Stop"}')"

echo "ship-cleanup (clean up only when commit landed):"
mkdir -p .claude/state
HEAD=$(git rev-parse HEAD)
printf '{"branch":"b","head_sha":"%s","staged_tree_sha":"z","timestamp_iso":"2026-01-01T00:00:00Z"}' "$HEAD" >.claude/state/ship-ready.json
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"}}' | "$H/ship-cleanup.sh" >/dev/null 2>&1
[ -f .claude/state/ship-ready.json ]
ck 0 "keeps marker when HEAD unchanged (commit failed)" $?
printf '{"branch":"b","head_sha":"deadbeef","staged_tree_sha":"z","timestamp_iso":"2026-01-01T00:00:00Z"}' >.claude/state/ship-ready.json
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"}}' | "$H/ship-cleanup.sh" >/dev/null 2>&1
[ -f .claude/state/ship-ready.json ]
ck 1 "deletes marker when HEAD advanced (commit landed)" $?
rm -f .claude/state/ship-ready.json
: >.claude/state/claimed-done
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"SHIP_BYPASS=1 git commit -m x"}}' | "$H/ship-cleanup.sh" >/dev/null 2>&1
[ -f .claude/state/claimed-done ]
ck 0 "keeps claimed-done when no marker (bypass path)" $?

echo "commit-gate B2 / write-review dod_met (with a controlled diff):"
printf 'export const _t = 1;\n' >"$TMP"
git add "$TMP"
printf '%s' '{"track":"t","acceptance_criteria":[{"text":"x"}],"scope_paths":["**"]}' | "$H/write-plan.sh" set - >/dev/null 2>&1
printf '%s' '{"prompt":"approve-plan"}' | "$H/approval-gate.sh" >/dev/null 2>&1
printf '%s' '{}' | "$H/write-review.sh" - --allow-no-tests >/dev/null 2>&1
grep -q '"dod_met": false' .claude/state/review.json
ck 0 "absent dod_met defaults to false" $?
printf 'export const _u = 2;\n' >>"$TMP"
OUT=$(printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"}}' | "$H/commit-gate.sh" 2>&1)
printf '%s' "$OUT" | grep -q "unstaged changes present"
ck 0 "commit-gate flags unstaged changes" $?

echo "human approval (agent cannot self-approve):"
rm -rf .claude/state
git reset -q -- "$TMP" 2>/dev/null || true
printf '%s' '{"track":"t","acceptance_criteria":[{"text":"x"}],"scope_paths":["**"]}' | "$H/write-plan.sh" set - >/dev/null 2>&1
grep -q '"approved": false' .claude/state/plan.json
ck 0 "draft plan is approved:false" $?
"$H/write-plan.sh" approve >/dev/null 2>&1
ck 1 "agent self-approve (write-plan.sh approve) is refused" $?
printf '%s' '{"prompt":"please approve-plan now"}' | "$H/approval-gate.sh" >/dev/null 2>&1
grep -q '"approved": true' .claude/state/plan.json
ck 0 "human approve-plan prompt stamps approved:true" $?
edit_after_approve=$(printf '%s' '{"tool_name":"Write","tool_input":{"file_path":"packages/db/x.ts"}}' | "$H/edit-gate.sh"; echo $?)
ck 0 "edit-gate allows source after human plan approval" $edit_after_approve

echo "human pass-approval + full gate chain:"
printf 'export const _h = 1;\n' >"$TMP"
git add "$TMP"
printf '%s' '{"dod_met":true}' | "$H/write-review.sh" - --allow-no-tests >/dev/null 2>&1
"$H/write-ship-marker.sh" >/dev/null 2>&1
no_pass=$(printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"}}' | "$H/commit-gate.sh" 2>&1)
printf '%s' "$no_pass" | grep -q "no human pass-approval"
ck 0 "commit blocked without human pass-approval" $?
printf '%s' '{"prompt":"approve-ship"}' | "$H/approval-gate.sh" >/dev/null 2>&1
OTHER=$(git status --porcelain | grep -v '_hooktest_tmp' || true)
if [ -n "$OTHER" ]; then
  echo "  skip  full-chain ALLOW assertions (working tree has other uncommitted changes; asserted in CI's clean checkout)"
else
  with_pass=$(printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"}}' | "$H/commit-gate.sh" >/dev/null 2>&1; echo $?)
  ck 0 "full gate chain ALLOWS commit (plan+review+dod+marker+pass-approval, fully staged)" "$with_pass"
  rm -f .claude/state/pass-approved.json
  autopass=$(printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"}}' | OPENWIND_AUTOPASS=1 "$H/commit-gate.sh" >/dev/null 2>&1; echo $?)
  ck 0 "OPENWIND_AUTOPASS=1 skips the human pass-approval requirement" "$autopass"
fi

echo "mark-done produces the sentinel verify-stop checks:"
rm -f .claude/state/claimed-done
"$H/mark-done.sh" >/dev/null 2>&1
[ -f .claude/state/claimed-done ]
ck 0 "mark-done writes claimed-done" $?

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
