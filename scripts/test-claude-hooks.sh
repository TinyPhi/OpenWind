#!/usr/bin/env bash
# test-claude-hooks.sh — unit tests for the Claude Code guardrail hooks.
# Runs in CI (contribution-guardrails workflow). Feeds each hook sample stdin and asserts
# its block (exit 2) / allow (exit 0) behaviour, so a PR that breaks a gate's logic fails
# CI instead of silently weakening enforcement. NOTE: the full gate-chain happy-path
# assertions are skipped locally when the working tree has uncommitted changes — they
# always run in CI's clean checkout. No network. Side effects (a temp file + .claude/state)
# are cleaned up on exit (existing .claude/state is saved and restored).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
H=.claude/hooks
PASS=0
FAIL=0
TMP=.claude/_hooktest_tmp.ts

# Save any live gate state before tests mutate it, restore on exit so running
# this script locally mid-session doesn't destroy plan.json / review.json / etc.
_STATE_BACKUP=
if [ -d .claude/state ]; then
  _STATE_BACKUP="$(mktemp -d)"
  cp -r .claude/state/. "$_STATE_BACKUP/"
fi

cleanup() {
  git reset -q -- "$TMP" 2>/dev/null || true
  rm -f "$TMP"
  rm -rf .claude/state
  if [ -n "${_STATE_BACKUP:-}" ] && [ -d "$_STATE_BACKUP" ]; then
    mkdir -p .claude/state
    cp -r "$_STATE_BACKUP/." .claude/state/
    rm -rf "$_STATE_BACKUP"
  fi
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
ck 2 ".mts under packages gated" "$(hook edit-gate.sh '{"tool_name":"Write","tool_input":{"file_path":"packages/db/x.mts"}}')"
ck 0 "outside source roots ignored" "$(hook edit-gate.sh '{"tool_name":"Edit","tool_input":{"file_path":"docs/x.md"}}')"

echo "commit-gate (bypass anchoring):"
ck 2 "SHIP_BYPASS token in -m message does NOT bypass" "$(hook commit-gate.sh '{"tool_name":"Bash","tool_input":{"command":"git commit -m \"SHIP_BYPASS=1 x\""}}')"
ck 0 "SHIP_BYPASS prefix bypasses (standalone)" "$(hook commit-gate.sh '{"tool_name":"Bash","tool_input":{"command":"SHIP_BYPASS=1 git commit -m x"}}')"
ck 0 "SHIP_BYPASS prefix bypasses (mid-compound)" "$(hook commit-gate.sh '{"tool_name":"Bash","tool_input":{"command":"cd /tmp && SHIP_BYPASS=1 git commit -m x"}}')"
ck 0 "non-commit git command ignored" "$(hook commit-gate.sh '{"tool_name":"Bash","tool_input":{"command":"git status"}}')"
ck 0 "quoted subcommand git \"commit\" is a best-effort miss (allowed; quotes = data)" "$(hook commit-gate.sh '{"tool_name":"Bash","tool_input":{"command":"git \"commit\" -m x"}}')"
ck 2 "git -c k=v commit still gated" "$(hook commit-gate.sh '{"tool_name":"Bash","tool_input":{"command":"git -c user.name=A commit -m x"}}')"
ck 0 "grep mentioning \"git commit\" NOT gated" "$(hook commit-gate.sh '{"tool_name":"Bash","tool_input":{"command":"grep -r \"git commit\" docs/"}}')"
ck 0 "echo mentioning git commit NOT gated" "$(hook commit-gate.sh '{"tool_name":"Bash","tool_input":{"command":"echo \"remember to git commit later\""}}')"

echo "destructive-guard:"
ck 2 "rm -rf / blocked" "$(hook destructive-guard.sh '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}')"
ck 2 "rm --recursive --force ~ blocked (long form)" "$(hook destructive-guard.sh '{"tool_name":"Bash","tool_input":{"command":"rm --recursive --force ~/data"}}')"
ck 0 "rm -rf node_modules allowed" "$(hook destructive-guard.sh '{"tool_name":"Bash","tool_input":{"command":"rm -rf node_modules"}}')"
ck 2 "rm -rf quoted root blocked (no quote-hiding)" "$(hook destructive-guard.sh '{"tool_name":"Bash","tool_input":{"command":"rm -rf \"/\""}}')"
ck 2 "rm -rf glob blocked" "$(hook destructive-guard.sh '{"tool_name":"Bash","tool_input":{"command":"rm -rf ./*"}}')"
ck 2 "find -delete blocked" "$(hook destructive-guard.sh '{"tool_name":"Bash","tool_input":{"command":"find . -name x -delete"}}')"
ck 0 "rm -rf subdir glob allowed (dist/*.map)" "$(hook destructive-guard.sh '{"tool_name":"Bash","tool_input":{"command":"rm -rf dist/*.map"}}')"
ck 0 "truncate grow allowed (-s 100M)" "$(hook destructive-guard.sh '{"tool_name":"Bash","tool_input":{"command":"truncate -s 100M sparsefile"}}')"
ck 2 "git push --force blocked" "$(hook destructive-guard.sh '{"tool_name":"Bash","tool_input":{"command":"git push --force"}}')"
ck 2 "git push +refspec force blocked" "$(hook destructive-guard.sh '{"tool_name":"Bash","tool_input":{"command":"git push origin +main"}}')"
ck 0 "normal git push allowed (no force)" "$(hook destructive-guard.sh '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}')"
ck 2 "git commit --no-verify blocked" "$(hook destructive-guard.sh '{"tool_name":"Bash","tool_input":{"command":"git commit --no-verify -m x"}}')"
ck 2 "git commit -anm combined flag blocked" "$(hook destructive-guard.sh '{"tool_name":"Bash","tool_input":{"command":"git commit -anm wip"}}')"
ck 0 "commit msg mentioning -n flag NOT blocked" "$(hook destructive-guard.sh '{"tool_name":"Bash","tool_input":{"command":"git commit -m \"fix: handle -n flag in parser\""}}')"
ck 2 "git commit --no-verify AFTER -m still blocked" "$(hook destructive-guard.sh '{"tool_name":"Bash","tool_input":{"command":"git commit -m x --no-verify"}}')"
ck 2 "rm -rf .. (bare parent) blocked" "$(hook destructive-guard.sh '{"tool_name":"Bash","tool_input":{"command":"rm -rf .."}}')"

echo "protected-paths:"
ck 2 "modules/*.ts blocked" "$(hook protected-paths.sh '{"tool_name":"Write","tool_input":{"file_path":"modules/crm/x.ts"}}')"
ck 2 ".env* blocked" "$(hook protected-paths.sh '{"tool_name":"Write","tool_input":{"file_path":".env.local"}}')"
ck 2 "ADR files blocked" "$(hook protected-paths.sh '{"tool_name":"Edit","tool_input":{"file_path":"docs/decisions/ADR-001-multitenancy.md"}}')"
ck 2 "prod.env (non-dotfile secret) blocked" "$(hook protected-paths.sh '{"tool_name":"Write","tool_input":{"file_path":"apps/api/prod.env"}}')"
ck 0 ".env.example allowed" "$(hook protected-paths.sh '{"tool_name":"Write","tool_input":{"file_path":".env.example"}}')"
ck 0 "modules stub index.ts allowed by config-first" "$(hook protected-paths.sh '{"tool_name":"Write","tool_input":{"file_path":"modules/crm/index.ts"}}')"
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
rm -f .claude/state/plan.json
printf '%s' '{"track":"t","acceptance_criteria":[{"text":"x"}],"scope_paths":["**"]}' | "$H/write-plan.sh" set - >/dev/null 2>&1
printf '%s' '{"prompt":"what does approve-plan do?"}' | "$H/approval-gate.sh" >/dev/null 2>&1
grep -q '"approved": false' .claude/state/plan.json
ck 0 "question mentioning approve-plan does NOT approve" $?
printf '%s' '{"prompt":"approve-plan"}' | "$H/approval-gate.sh" >/dev/null 2>&1  # re-approve so the edit-gate precondition holds
edit_after_approve=$(printf '%s' '{"tool_name":"Write","tool_input":{"file_path":"packages/db/x.ts"}}' | "$H/edit-gate.sh"; echo $?)
ck 0 "edit-gate allows source after human plan approval" $edit_after_approve

echo "approve-ship guard (no marker = no pass-approved written):"
rm -f .claude/state/ship-ready.json .claude/state/pass-approved.json
printf '%s' '{"prompt":"how does approve-ship work?"}' | "$H/approval-gate.sh" >/dev/null 2>&1
[ -f .claude/state/pass-approved.json ]
ck 1 "approve-ship keyword in question does NOT write pass-approved without a marker" $?

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
  echo "  skip  full-chain ALLOW assertions (working tree has uncommitted changes; these always run in CI's clean checkout — see header note)"
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
