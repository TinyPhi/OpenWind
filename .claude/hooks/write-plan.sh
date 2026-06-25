#!/usr/bin/env bash
# write-plan.sh — helper for the PLAN stage (/spec-tasks or the openwind-loop pick step).
# Usage:
#   write-plan.sh set <payload.json|->   # write plan-lock (approved:false) from a payload
#   write-plan.sh approve                # mark the current branch plan-lock human-approved
# Payload fields: track, spec_ref, adr_refs[], acceptance_criteria[{id,text,verify}], scope_paths[]
set -euo pipefail
REPO="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-$PWD}")"
export REPO
exec node -e '
const fs=require("fs"), cp=require("child_process");
const repo=process.env.REPO, mode=process.argv[1]||"";
const statePath=repo+"/.claude/state/plan.json";
fs.mkdirSync(repo+"/.claude/state",{recursive:true});
function branch(){ try{return cp.execSync("git rev-parse --abbrev-ref HEAD",{cwd:repo}).toString().trim();}catch(e){return "";} }
function baseSha(){ for(const c of ["git merge-base HEAD origin/main","git rev-parse main","git rev-parse HEAD"]){ try{return cp.execSync(c,{cwd:repo}).toString().trim();}catch(e){} } return ""; }
if(mode==="approve"){
  console.error("Plan approval is HUMAN-ONLY and cannot be performed by the agent. The human types \"approve-plan\" in chat; the approval-gate (UserPromptSubmit) hook stamps approved:true. Use write-plan.sh set to draft or redraft the plan.");
  process.exit(1);
}
if(mode==="set"){
  const src=process.argv[2]; if(!src){console.error("usage: write-plan.sh set <payload.json|->");process.exit(1);}
  const raw=src==="-"?fs.readFileSync(0,"utf8"):fs.readFileSync(src,"utf8");
  let p; try{p=JSON.parse(raw);}catch(e){console.error("payload is not valid JSON: "+e.message);process.exit(1);}
  const plan={
    branch:branch(), created_iso:new Date().toISOString(), base_sha:baseSha(),
    track:p.track||null, spec_ref:p.spec_ref||null, adr_refs:p.adr_refs||[],
    approved:false, approved_iso:null,
    acceptance_criteria:(p.acceptance_criteria||[]).map((c,i)=>({id:(c&&c.id)||("AC"+(i+1)),text:(c&&c.text)||String(c),verify:(c&&c.verify)||null,done:false})),
    scope_paths:p.scope_paths||[]
  };
  fs.writeFileSync(statePath,JSON.stringify(plan,null,2));
  console.log("plan-lock DRAFTED (approved:false) for "+plan.branch+". Present the criteria to the human; they type \"approve-plan\" in chat to approve (the agent cannot self-approve).");
  process.exit(0);
}
console.error("usage: write-plan.sh set <payload.json|-> | write-plan.sh approve"); process.exit(1);
' "$@"
