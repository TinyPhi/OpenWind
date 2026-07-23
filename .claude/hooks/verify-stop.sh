#!/usr/bin/env bash
# verify-stop.sh — Stop
# Backstop against a FALSE "done": only acts when the agent has written a
# .claude/state/claimed-done/<branch-slug> sentinel (it asserted the unit is complete). It then
# does a CHEAP pipeline-completion check (is source still uncommitted?) — it does NOT re-run
# typecheck/lint (the commit step already owns verification; re-running is wasted cost).
# Never fires on a normal mid-task pause (no sentinel => allow). Exit 2 = block the stop.
#
# Worktree-aware: a Stop event carries no file path or command to anchor on, so this scans the
# main checkout AND every linked `git worktree` for a claimed-done sentinel matching that
# location's own checked-out branch, and runs the dirty-check there.
REPO="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-$PWD}")"
export REPO
export LIBDIR="${CLAUDE_PROJECT_DIR:-$REPO}/.claude/hooks/lib"
exec node -e '
const fs = require("fs");
const ctx = require(process.env.LIBDIR + "/context.js");
const repo = process.env.REPO;
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch (e) {}
// Avoid re-entrancy loops: if this Stop is already a hook continuation, allow.
if (input.stop_hook_active === true) process.exit(0);
const problems = [];
for (const dir of ctx.listWorktrees(repo)) {
  const branch = ctx.branchOf(dir);
  if (!branch) continue;
  const sentinelPath = ctx.stateDir(dir, "claimed-done") + "/" + ctx.slug(branch);
  let sentinel = false;
  try { fs.accessSync(sentinelPath); sentinel = true; } catch (e) {}
  if (!sentinel) continue;
  // Scope is intentionally product-code only (apps/ packages/ modules/ tests/).
  // Changes to .claude/, scripts/, or root config files are excluded — the commit-gate
  // and its review-diff check are the authoritative guards for those paths.
  const dirty = ctx.sh("git status --porcelain -- apps packages modules tests", dir);
  if (!dirty) { try { fs.unlinkSync(sentinelPath); } catch (e) {} continue; }
  problems.push({ dir, branch, dirty });
}
if (problems.length === 0) process.exit(0);
const msg = problems.map(p =>
  p.branch + " (" + p.dir + ") - uncommitted source changes remain:\n" + p.dirty.split("\n").slice(0, 12).join("\n")
).join("\n\n");
process.stderr.write(
  "VERIFY-STOP - you claimed done, but the pipeline did not complete.\n" + msg + "\n" +
  "Finish the commit procedure (all edits -> /review -> marker -> commit), or if you are intentionally\n" +
  "pausing mid-work, clear the claim: rm .claude/state/claimed-done/<branch-slug> (in the relevant checkout)\n"
);
process.exit(2);
'
