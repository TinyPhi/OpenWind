#!/usr/bin/env bash
# session-start.sh — SessionStart
# Injects the delivery-guardrail rules into context every session as a reminder. These are
# best-effort nudges, not an enforcement boundary (the body text says so explicitly).
cat <<'EOF'
OpenWind delivery guardrails are ACTIVE for Claude Code in this repo (plain git + CI are unaffected).
These are GUARDRAILS, not barricades - a best-effort speed bump that catches honest mistakes and makes
the disciplined path the default. They are NOT a security boundary (a determined agent can bypass
them). The real gate is CI (active today); required PR review + branch protection are recommended and must be enabled in repo settings.

Pipeline - the hooks nudge you to produce each stage's artifact before the next:
  PLAN  -> agent drafts acceptance criteria + scope (/spec-tasks or the openwind-loop pick step).
           The HUMAN approves by typing "approve-plan" in chat (so accidental self-approval is
           unlikely; the un-fakeable human gate is the PR review). Edit gate guards source edits.
  CODE  -> all edits + tests land first. No mid-review.
  REVIEW-> one /review at the end (+ /security-review if auth/db/routes/files/secrets). Writes review.json.
  SHIP  -> run `pnpm typecheck && pnpm lint && pnpm test && pnpm test:isolation`, write the marker,
           then the HUMAN types "approve-ship" to approve the pass. Commit gate blocks `git commit`
           until the marker, the review, AND the human pass-approval all match the diff. Never raw `git commit`.

Best-effort blocks (with documented bypass env, all logged to .claude/state/bypass.log):
  - edit source without a HUMAN-approved plan-lock                       (OPENWIND_GATE=off)
  - git commit without marker + matching review + human pass-approval    (SHIP_BYPASS=1)
  - edit on main/develop, modules/*.ts, ADRs, .github/workflows/*        (OPENWIND_OFFLIMITS=ack / OPENWIND_ALLOW_MODULE_TS=1)
  - rm -rf risky / DROP / --no-verify / push --force                     (no bypass)

Graduated-trust toggles (skip only the HUMAN-typing step; the underlying artifact - plan-lock
or review+docs+marker - is still required, and these are NOT logged as bypasses):
  - approve-plan typing not required, plan-lock still required           (OPENWIND_PLAN_AUTOPASS=1)
  - approve-ship typing not required, marker+review+docs still required  (OPENWIND_AUTOPASS=1)

Completion: when you are sure the unit is done, run .claude/hooks/mark-done.sh; the Stop hook then
confirms the pipeline actually finished (everything committed) before the session can end.

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

