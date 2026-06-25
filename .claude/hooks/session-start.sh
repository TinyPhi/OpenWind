#!/usr/bin/env bash
# session-start.sh — SessionStart
# Injects the gated-delivery rules into context every session (mechanical, not advisory:
# the agent cannot rationalise away a rule it is reminded of every session AND a hook enforces).
cat <<'EOF'
OpenWind gated delivery is ACTIVE for Claude Code in this repo (plain git + CI are unaffected).

Pipeline — each stage gated on the prior stage's artifact (hard-block for all sessions):
  PLAN  -> agent drafts acceptance criteria + scope (/spec-tasks or the openwind-loop pick step).
           The HUMAN approves by typing "approve-plan" in chat - the agent CANNOT self-approve.
           Edit gate blocks source edits until plan.json is human-approved.
  CODE  -> all edits + tests land first. No mid-review.
  REVIEW-> one /review at the end (+ /security-review if auth/db/routes/files/secrets). Writes review.json.
  SHIP  -> run `pnpm typecheck && pnpm lint && pnpm test && pnpm test:isolation`, write the marker,
           then the HUMAN types "approve-ship" to approve the pass. Commit gate blocks `git commit`
           until the marker, the review, AND the human pass-approval all match the diff. Never raw `git commit`.

Hard blocks (with bypass env, all logged to .claude/state/bypass.log):
  - edit source without a HUMAN-approved plan-lock                       (OPENWIND_GATE=off)
  - git commit without marker + matching review + human pass-approval    (SHIP_BYPASS=1)
  - edit on main/develop, modules/*.ts, ADRs, .github/workflows/*        (OPENWIND_OFFLIMITS=ack / OPENWIND_ALLOW_MODULE_TS=1)
  - rm -rf risky / DROP / --no-verify / push --force                     (no bypass)

Completion: when you are sure the unit is done, run .claude/hooks/mark-done.sh; the Stop hook then
confirms the pipeline actually finished (everything committed) before the session can end. The human
pass-approval ("approve-ship") is required on every commit until the owner sets OPENWIND_AUTOPASS=1.

Source of truth: CLAUDE.md (Current Focus + Off-limits), the relevant docs/decisions/ADR,
docs/sup-docs/{roadmap-tracker,week-log}.md, .claude/references/definition-of-done.md, .claude/README.md.
EOF

# Surface working context if present (folded from PR #132's PROGRESS/BLOCKERS idea, path-fixed).
REPO="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-$PWD}")"
for f in BLOCKERS.md PROGRESS.md; do
  if [ -f "$REPO/$f" ]; then
    echo
    echo "=== $f (latest) ==="
    tail -40 "$REPO/$f"
  fi
done
exit 0

