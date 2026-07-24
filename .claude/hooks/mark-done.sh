#!/usr/bin/env bash
# mark-done.sh — the agent calls this to assert "this unit is complete".
# Writes the claimed-done sentinel that verify-stop checks on session end: if the agent
# asserts done but the pipeline did not actually finish (uncommitted source/tests), verify-stop
# blocks the stop. This is the producer that gives verify-stop teeth.
# Sentinel is keyed by branch (.claude/state/claimed-done/<branch-slug>) - run this from
# whichever checkout (main or worktree) the unit of work actually happened in.
REPO="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-$PWD}")"
LIBDIR="${CLAUDE_PROJECT_DIR:-$REPO}/.claude/hooks/lib"
BRANCH="$(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown-branch)"
SLUG="$(node -e 'console.log(require(process.argv[1]+"/context.js").slug(process.argv[2]))' "$LIBDIR" "$BRANCH")"
mkdir -p "$REPO/.claude/state/claimed-done"
: >"$REPO/.claude/state/claimed-done/$SLUG"
echo "claimed-done written for $BRANCH (repo: $REPO). verify-stop will confirm the pipeline actually completed (everything committed) before this session can end."
