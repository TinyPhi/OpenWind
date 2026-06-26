#!/usr/bin/env bash
# approval-gate.sh — UserPromptSubmit
# The ONLY path by which a human approval enters the system. It fires on the HUMAN's prompt,
# which the agent cannot emit (the agent produces tool calls + text, never a user prompt), so
# making ACCIDENTAL self-approval unlikely (not a hard guarantee - a determined agent can still write
# the state file; the un-fakeable human approval is the PR review). Detects two directives:
#   approve-plan  -> stamps the branch plan-lock approved:true (unlocks source edits)
#   approve-ship  -> writes pass-approved bound to the current diff (unlocks the commit)
# Never blocks; only records approval. Stdout is surfaced to the session as confirmation.
REPO="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-$PWD}")"
export REPO
exec node -e '
const fs = require("fs"), cp = require("child_process"), crypto = require("crypto");
const repo = process.env.REPO;
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch (e) {}
const prompt = (input.prompt || "").toString();
fs.mkdirSync(repo + "/.claude/state", { recursive: true });
function branch() { try { return cp.execSync("git rev-parse --abbrev-ref HEAD", { cwd: repo }).toString().trim(); } catch (e) { return ""; } }
function sha(args) { try { return crypto.createHash("sha256").update(cp.execSync("git " + args, { cwd: repo })).digest("hex"); } catch (e) { return null; } }
const out = [];
if (/\bapprove-plan\b/i.test(prompt)) {
  let plan = null;
  try { plan = JSON.parse(fs.readFileSync(repo + "/.claude/state/plan.json", "utf8")); } catch (e) {}
  if (!plan) out.push("[approval-gate] No plan-lock to approve - the agent must draft one (write-plan.sh set) first.");
  else if (plan.branch !== branch()) out.push("[approval-gate] Plan-lock is for " + plan.branch + ", not the current branch.");
  else {
    plan.approved = true; plan.approved_iso = new Date().toISOString(); plan.approved_by = "human:UserPromptSubmit";
    fs.writeFileSync(repo + "/.claude/state/plan.json", JSON.stringify(plan, null, 2));
    out.push("[approval-gate] PLAN APPROVED by human for " + plan.branch + " - source edits unlocked.");
  }
}
if (/\bapprove-ship\b/i.test(prompt)) {
  let marker = null;
  try { marker = JSON.parse(fs.readFileSync(repo + "/.claude/state/ship-ready.json", "utf8")); } catch (e) {}
  const staged = sha("diff --staged");
  if (!marker || marker.staged_tree_sha !== staged) {
    out.push("[approval-gate] Cannot record approve-ship: no ship marker for the current staged diff. Run the commit procedure (write-ship-marker.sh) first, then type 'approve-ship'.");
  } else {
    const rec = { branch: branch(), diff_sha: sha("diff HEAD"), approved_iso: new Date().toISOString(), approved_by: "human:UserPromptSubmit" };
    fs.writeFileSync(repo + "/.claude/state/pass-approved.json", JSON.stringify(rec, null, 2));
    out.push("[approval-gate] SHIP/PASS APPROVED by human for the current diff - the commit is unlocked while the diff is unchanged.");
  }
}
if (out.length) process.stdout.write(out.join("\n") + "\n");
process.exit(0);
'
