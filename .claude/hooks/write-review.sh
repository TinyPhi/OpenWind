#!/usr/bin/env bash
# write-review.sh — helper for the REVIEW stage, run after /review (and /security-review).
# Refuses unless: an APPROVED plan-lock exists for the branch, the working diff is non-empty,
# and tests are present in the diff. Binds the review to the final `git diff HEAD`.
# Usage: write-review.sh <payload.json|-> [--allow-no-tests]
# Payload: verdict, findings_triaged{accepted,deferred,rejected}, dod_met, dod_unmet[], security_review
#
# Review state is keyed by branch (.claude/state/review/<branch-slug>.json).
set -euo pipefail
REPO="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-$PWD}")"
export REPO
export LIBDIR="${CLAUDE_PROJECT_DIR:-$REPO}/.claude/hooks/lib"
exec node -e '
const fs=require("fs");
const ctx=require(process.env.LIBDIR+"/context.js");
const repo=process.env.REPO;
const args=process.argv.slice(1);
const allowNoTests=args.includes("--allow-no-tests");
const src=args.find(a=>!a.startsWith("--"));
if(!src){console.error("usage: write-review.sh <payload.json|-> [--allow-no-tests]");process.exit(1);}
const branch=ctx.branchOf(repo);
const plan=ctx.readJSON(ctx.statePath(repo,"plan",branch));
if(!(plan&&plan.branch===branch&&plan.approved===true)){console.error("Cannot review: no APPROVED plan-lock for "+branch+". Freeze + approve a plan first.");process.exit(1);}
// Hash the RAW (untrimmed) diff buffer - must match the sha("diff HEAD") computed by
// commit-gate.sh and approval-gate.sh, which also hash the raw buffer via ctx.shBuf.
// Trimming before hashing would make this diff_sha disagree with theirs over an
// incidental trailing newline, breaking the "review covers exactly what is committed" check.
const diffBuf=ctx.shBuf("git diff HEAD",repo);
if(!diffBuf.toString().trim()){console.error("Cannot review: git diff HEAD is empty - nothing to review.");process.exit(1);}
const changed=ctx.sh("git diff HEAD --name-only",repo).split("\n").filter(Boolean);
const testsPresent=changed.some(f=>/\.(test|spec)\.[tj]sx?$|(^|\/)tests?\//.test(f));
if(!testsPresent&&!allowNoTests){console.error("Cannot review: no test files in the diff. Review needs plan+code+tests. Add tests, or pass --allow-no-tests for a genuinely test-exempt change (docs/config).");process.exit(1);}
const raw=src==="-"?fs.readFileSync(0,"utf8"):fs.readFileSync(src,"utf8");
let p={}; try{p=JSON.parse(raw);}catch(e){console.error("payload is not valid JSON: "+e.message);process.exit(1);}
const review={
  branch, reviewed_iso:new Date().toISOString(),
  diff_sha:ctx.sha256(diffBuf),
  verdict:p.verdict||"pass",
  findings_triaged:p.findings_triaged||{accepted:[],deferred:[],rejected:[]},
  tests_present:testsPresent,
  dod_met:p.dod_met===true,
  dod_unmet:p.dod_unmet||[],
  security_review:(p.security_review===undefined?null:p.security_review)
};
ctx.writeJSON(ctx.statePath(repo,"review",branch), review);
console.log("review written for "+branch+" (repo: "+repo+", verdict="+review.verdict+", tests="+testsPresent+", dod_met="+review.dod_met+"). Commit now - any further edit invalidates it.");
process.exit(0);
' "$@"
