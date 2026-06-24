#!/usr/bin/env bash
# write-ship-marker.sh — helper for the SHIP step, run immediately before `git commit`.
# Writes .claude/state/ship-ready.json bound to the current staged tree (valid 30 min).
set -euo pipefail
REPO="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-$PWD}")"
export REPO
exec node -e '
const fs=require("fs"), cp=require("child_process"), crypto=require("crypto");
const repo=process.env.REPO;
fs.mkdirSync(repo+"/.claude/state",{recursive:true});
function shBuf(c){try{return cp.execSync(c,{cwd:repo});}catch(e){return Buffer.from("");}}
const staged=shBuf("git diff --staged");
if(!staged.toString().trim()){console.error("Nothing staged - stage your changes before writing the ship marker.");process.exit(1);}
const marker={
  branch:shBuf("git rev-parse --abbrev-ref HEAD").toString().trim(),
  staged_tree_sha:crypto.createHash("sha256").update(staged).digest("hex"),
  head_sha:shBuf("git rev-parse HEAD").toString().trim(),
  timestamp_iso:new Date().toISOString()
};
fs.writeFileSync(repo+"/.claude/state/ship-ready.json",JSON.stringify(marker,null,2));
console.log("ship marker written for "+marker.branch+" (staged_sha="+marker.staged_tree_sha.slice(0,12)+"...). Commit now - valid 30 min.");
process.exit(0);
'
