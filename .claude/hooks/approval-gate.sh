#!/usr/bin/env bash
# approval-gate.sh — UserPromptSubmit
# The ONLY path by which a human approval enters the system. It fires on the HUMAN's prompt,
# which the agent cannot emit (the agent produces tool calls + text, never a user prompt), so
# making ACCIDENTAL self-approval unlikely (not a hard guarantee - a determined agent can still write
# the state file; the un-fakeable human approval is the PR review). Detects two directives:
#   approve-plan  -> stamps the branch plan-lock approved:true (unlocks source edits)
#   approve-ship  -> writes pass-approved bound to the current diff (unlocks the commit)
# Never blocks; only records approval. Stdout is surfaced to the session as confirmation.
#
# Worktree-aware: this hook fires with cwd == the main checkout no matter which worktree the
# agent has actually been editing/shipping in (a plain chat message carries no file path or
# command to anchor on, unlike edit-gate/commit-gate). So it scans the main checkout AND every
# linked `git worktree` for a pending plan-lock / ship-ready marker on ITS OWN checked-out
# branch, and approves whichever single one matches. If more than one location has a pending
# item, it reports the ambiguity instead of guessing which branch the human meant.
REPO="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-$PWD}")"
export REPO
export LIBDIR="${CLAUDE_PROJECT_DIR:-$REPO}/.claude/hooks/lib"
exec node -e '
const fs = require("fs");
const ctx = require(process.env.LIBDIR + "/context.js");
const repo = process.env.REPO;
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch (e) {}
const prompt = (input.prompt || "").toString();
const out = [];
function sha(args, dir) { return ctx.sha256(ctx.shBuf("git " + args, dir)); }
function isApprove(kw) {
  // fire only when the directive LEADS a line (optionally after a short affirmative) and is not
  // negated/questioned - so "what does approve-ship do?" or "do NOT approve-plan" do not approve.
  const atStart = new RegExp("(?:^|\\n)\\s*(?:ok|yes|please|sure|go ahead|approved?)?[\\s,:!.-]*" + kw + "\\b", "i").test(prompt);
  const negated = new RegExp("\\b(?:not|never|no|why|what|how|explain|describe|cannot)\\b[^\\n]*" + kw, "i").test(prompt);
  return atStart && !negated;
}
const locations = ctx.listWorktrees(repo);
if (isApprove("approve-plan")) {
  const candidates = [];
  for (const dir of locations) {
    const branch = ctx.branchOf(dir);
    if (!branch) continue;
    const plan = ctx.readJSON(ctx.statePath(dir, "plan", branch));
    if (plan && plan.branch === branch && plan.approved !== true) candidates.push({ dir, branch, plan });
  }
  if (candidates.length === 0) {
    out.push("[approval-gate] No pending plan-lock to approve in " + locations.length + " checked location(s) (main + worktrees) - the agent must draft one (write-plan.sh set) first.");
  } else if (candidates.length > 1) {
    out.push("[approval-gate] Ambiguous: " + candidates.length + " pending plan-locks found - " + candidates.map(c => c.branch + " (" + c.dir + ")").join(", ") + ". Say which branch to approve.");
  } else {
    const { dir, branch, plan } = candidates[0];
    plan.approved = true; plan.approved_iso = new Date().toISOString(); plan.approved_by = "human:UserPromptSubmit";
    ctx.writeJSON(ctx.statePath(dir, "plan", branch), plan);
    out.push("[approval-gate] PLAN APPROVED by human for " + branch + " (" + dir + ") - source edits unlocked.");
  }
}
if (isApprove("approve-ship")) {
  const candidates = [];
  for (const dir of locations) {
    const branch = ctx.branchOf(dir);
    if (!branch) continue;
    const marker = ctx.readJSON(ctx.statePath(dir, "ship-ready", branch));
    if (marker && marker.staged_tree_sha === sha("diff --staged", dir)) candidates.push({ dir, branch });
  }
  if (candidates.length === 0) {
    out.push("[approval-gate] Cannot record approve-ship: no ship marker matches the current staged diff in " + locations.length + " checked location(s). Run the commit procedure (write-ship-marker.sh) first, then type \x27approve-ship\x27.");
  } else if (candidates.length > 1) {
    out.push("[approval-gate] Ambiguous: " + candidates.length + " locations have a matching ship marker - " + candidates.map(c => c.branch + " (" + c.dir + ")").join(", ") + ". Say which branch to approve.");
  } else {
    const { dir, branch } = candidates[0];
    const rec = { branch, diff_sha: sha("diff HEAD", dir), approved_iso: new Date().toISOString(), approved_by: "human:UserPromptSubmit" };
    ctx.writeJSON(ctx.statePath(dir, "pass-approved", branch), rec);
    out.push("[approval-gate] SHIP/PASS APPROVED by human for " + branch + " (" + dir + ") - the commit is unlocked while the diff is unchanged.");
  }
}
if (out.length) process.stdout.write(out.join("\n") + "\n");
process.exit(0);
'
