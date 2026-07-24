#!/usr/bin/env bash
# write-plan.sh — helper for the PLAN stage (/spec-tasks or the openwind-loop pick step).
# Usage:
#   write-plan.sh set <payload.json|->   # write plan-lock (approved:false) from a payload
#   write-plan.sh approve                # mark the current branch plan-lock human-approved
# Payload fields: track, spec_ref, adr_refs[], acceptance_criteria[{id,text,verify}], scope_paths[]
#
# Plan-lock state is keyed by branch (.claude/state/plan/<branch-slug>.json) so drafting
# a plan for one branch never clobbers another branch's plan-lock.
set -euo pipefail
REPO="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-$PWD}")"
export REPO
export LIBDIR="${CLAUDE_PROJECT_DIR:-$REPO}/.claude/hooks/lib"
exec node -e '
const fs=require("fs");
const ctx=require(process.env.LIBDIR+"/context.js");
const repo=process.env.REPO, mode=process.argv[1]||"";
function baseSha(){ for(const c of ["git merge-base HEAD origin/main","git rev-parse main","git rev-parse HEAD"]){ const r=ctx.sh(c,repo); if(r) return r; } return ""; }
if(mode==="approve"){
  console.error("Plan approval is HUMAN-ONLY and cannot be performed by the agent. The human types \"approve-plan\" in chat; the approval-gate (UserPromptSubmit) hook stamps approved:true. Use write-plan.sh set to draft or redraft the plan.");
  process.exit(1);
}
if(mode==="set"){
  const src=process.argv[2]; if(!src){console.error("usage: write-plan.sh set <payload.json|->");process.exit(1);}
  const raw=src==="-"?fs.readFileSync(0,"utf8"):fs.readFileSync(src,"utf8");
  let p; try{p=JSON.parse(raw);}catch(e){console.error("payload is not valid JSON: "+e.message);process.exit(1);}
  const branch=ctx.branchOf(repo);
  const plan={
    branch, created_iso:new Date().toISOString(), base_sha:baseSha(),
    track:p.track||null, spec_ref:p.spec_ref||null, adr_refs:p.adr_refs||[],
    approved:false, approved_iso:null,
    acceptance_criteria:(p.acceptance_criteria||[]).map((c,i)=>({id:(c&&c.id)||("AC"+(i+1)),text:(c&&c.text)||String(c),verify:(c&&c.verify)||null,done:false})),
    scope_paths:p.scope_paths||[]
  };
  ctx.writeJSON(ctx.statePath(repo,"plan",branch), plan);
  console.log("plan-lock DRAFTED (approved:false) for "+branch+" (repo: "+repo+"). Present the criteria to the human; they type \"approve-plan\" in chat to approve (the agent must not self-approve).");
  process.exit(0);
}
console.error("usage: write-plan.sh set <payload.json|-> | write-plan.sh approve"); process.exit(1);
' "$@"
