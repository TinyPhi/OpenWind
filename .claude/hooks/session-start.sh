#!/usr/bin/env bash
# session-start.sh — SessionStart
# Injects the gated-delivery rules into context every session (mechanical, not advisory:
# the agent cannot rationalise away a rule it is reminded of every session AND a hook enforces).
cat <<'EOF'
OpenWind gated delivery is ACTIVE for Claude Code in this repo (plain git + CI are unaffected).

Pipeline — each stage gated on the prior stage's artifact (hard-block for all sessions):
  PLAN  -> freeze acceptance criteria + scope (/spec-tasks or the openwind-loop pick step),
           then YOU approve the freeze. Edit gate blocks source edits until plan.json has approved:true.
  CODE  -> all edits + tests land first. No mid-review.
  REVIEW-> one /review at the end (+ /security-review if auth/db/routes/files/secrets). Writes review.json.
  SHIP  -> commit step runs `pnpm typecheck && pnpm lint && pnpm test && pnpm test:isolation`,
           writes the commit marker, commits, pushes, opens a structured PR. Never raw `git commit`.

Hard blocks (with bypass env, all logged to .claude/state/bypass.log):
  - edit source without an approved plan-lock            (OPENWIND_GATE=off)
  - git commit without fresh marker + matching review    (SHIP_BYPASS=1)
  - edit on main/develop, modules/*.ts, ADRs, ci.yml      (OPENWIND_OFFLIMITS=ack / OPENWIND_ALLOW_MODULE_TS=1)
  - rm -rf risky / DROP / --no-verify / push --force      (no bypass)

Completion: write .claude/state/claimed-done only when truly done; the Stop hook checks the
pipeline actually finished. Humans approve every pass until OPENWIND_AUTOPASS=on.

Source of truth: CLAUDE.md (Current Focus + Off-limits), the relevant docs/decisions/ADR,
docs/sup-docs/{roadmap-tracker,week-log}.md, .claude/references/definition-of-done.md, .claude/README.md.
EOF
exit 0

