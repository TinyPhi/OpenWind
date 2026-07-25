#!/usr/bin/env bash
# write-docs-marker.sh — helper for the DOCS stage, run after /review and before
# write-ship-marker.sh. Confirms relevant docs were updated alongside this diff, or
# records an explicit justification for why none were needed. Realises "docs stay in
# sync with code, commit by commit" as part of the Plan -> Code -> Review -> Docs -> Ship
# pipeline. Binds to `git diff HEAD` like review.json does.
# Usage:
#   write-docs-marker.sh --touched            # doc files are already in the diff — record them
#   write-docs-marker.sh --skip "<reason>"     # explicitly justify why this diff needs no docs
set -euo pipefail
REPO="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-$PWD}")"
export REPO
exec node -e '
const fs=require("fs"), cp=require("child_process"), crypto=require("crypto");
const repo=process.env.REPO;
fs.mkdirSync(repo+"/.claude/state",{recursive:true});
const args=process.argv.slice(1);
function sh(c){try{return cp.execSync(c,{cwd:repo}).toString();}catch(e){return "";}}
const branch=sh("git rev-parse --abbrev-ref HEAD").trim();
const diff=sh("git diff HEAD");
if(!diff.trim()){console.error("Cannot write docs marker: git diff HEAD is empty - nothing to document.");process.exit(1);}
const diffSha=crypto.createHash("sha256").update(diff).digest("hex");
const changed=sh("git diff HEAD --name-only").split("\n").filter(Boolean);
const isDocFile=f=>/(^|\/)docs\//i.test(f) || /^CLAUDE\.md$/i.test(f) || /^README\.md$/i.test(f) || /^\.claude\/.*\.md$/i.test(f);
const touchedDocs=changed.filter(isDocFile);
const skipIdx=args.indexOf("--skip");
let mode, reason=null;
if(skipIdx!==-1){
  mode="skip";
  reason=args[skipIdx+1]||"";
  if(!reason){console.error("usage: write-docs-marker.sh --skip \"<reason this diff needs no doc update>\"");process.exit(1);}
} else if(args.includes("--touched")){
  mode="touched";
  if(touchedDocs.length===0){console.error("No doc files (docs/**, CLAUDE.md, README.md, .claude/**/*.md) found in the diff. Update docs and re-run, or use --skip \"<reason>\" if this genuinely needs none.");process.exit(1);}
} else {
  console.error("usage: write-docs-marker.sh --touched | --skip \"<reason>\"");
  process.exit(1);
}
const marker={branch,diff_sha:diffSha,mode,touched_docs:touchedDocs,skip_reason:reason,timestamp_iso:new Date().toISOString()};
fs.writeFileSync(repo+"/.claude/state/docs-updated.json",JSON.stringify(marker,null,2));
console.log("docs marker written for "+branch+" (mode="+mode+(mode==="touched"?", files="+touchedDocs.length:", reason=\""+reason+"\"")+"). Commit now - any further edit invalidates it.");
process.exit(0);
' -- "$@"
