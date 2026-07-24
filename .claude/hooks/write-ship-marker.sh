#!/usr/bin/env bash
# write-ship-marker.sh — helper for the SHIP step, run immediately before `git commit`.
# Writes .claude/state/ship-ready/<branch-slug>.json bound to the current staged tree
# (valid 60 min). Keyed by branch so drafting a marker on one branch never clobbers
# another branch's marker.
set -euo pipefail
REPO="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-$PWD}")"
export REPO
export LIBDIR="${CLAUDE_PROJECT_DIR:-$REPO}/.claude/hooks/lib"
exec node -e '
const ctx=require(process.env.LIBDIR+"/context.js");
const repo=process.env.REPO;
// RAW (untrimmed) buffer, hashed via the same ctx.sha256 commit-gate/approval-gate use -
// must agree with their sha("diff --staged") bit-for-bit.
const stagedBuf=ctx.shBuf("git diff --staged",repo);
if(!stagedBuf.toString().trim()){console.error("Nothing staged - stage your changes before writing the ship marker.");process.exit(1);}
const branch=ctx.branchOf(repo);
const marker={
  branch,
  staged_tree_sha:ctx.sha256(stagedBuf),
  head_sha:ctx.sh("git rev-parse HEAD",repo),
  timestamp_iso:new Date().toISOString()
};
ctx.writeJSON(ctx.statePath(repo,"ship-ready",branch), marker);
console.log("ship marker written for "+branch+" (repo: "+repo+", staged_sha="+marker.staged_tree_sha.slice(0,12)+"...). Write this LAST, after the exit condition + review; commit now - valid 60 min.");
process.exit(0);
'
