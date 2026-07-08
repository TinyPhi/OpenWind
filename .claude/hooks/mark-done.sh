#!/usr/bin/env bash
# mark-done.sh — the agent calls this to assert "this unit is complete".
# Writes the claimed-done sentinel that verify-stop checks on session end: if the agent
# asserts done but the pipeline did not actually finish (uncommitted source/tests), verify-stop
# blocks the stop. This is the producer that gives verify-stop teeth.
REPO="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-$PWD}")"
mkdir -p "$REPO/.claude/state"
: >"$REPO/.claude/state/claimed-done"
echo "claimed-done written. verify-stop will confirm the pipeline actually completed (everything committed) before this session can end."
