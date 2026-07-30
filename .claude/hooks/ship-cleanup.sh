#!/usr/bin/env bash
# ship-cleanup.sh — PostToolUse(Bash)
# One-shot: after a `git commit` runs, delete the ship marker so it can never be
# reused for a second commit. Also clears the claimed-done sentinel (pipeline finished).
# Worktree-aware: resolves the same target repo/branch commit-gate used for this command
# (see .claude/hooks/lib/context.js) so cleanup lands on the right worktree's state files.
REPO="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-$PWD}")"
export REPO
export LIBDIR="${CLAUDE_PROJECT_DIR:-$REPO}/.claude/hooks/lib"
exec node -e '
const fs = require("fs");
const ctx = require(process.env.LIBDIR + "/context.js");
const fallbackRepo = process.env.REPO;
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch (e) {}
if ((input.tool_name || "") !== "Bash") process.exit(0);
const cmd = (input.tool_input && input.tool_input.command) || "";
function gitSub(c, s) {
  const re = /\bgit\b((?:\s+(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?|-[A-Za-z]+))*)\s+([a-z][a-z-]*)/g;
  let m; while ((m = re.exec(c)) !== null) { if (m[2] === s) return true; } return false;
}
const noStr = cmd.replace(/"[^"]*"/g, " ").replace(/\x27[^\x27]*\x27/g, " ");
if (!gitSub(noStr, "commit")) process.exit(0);
const targetDir = ctx.targetDirFromCommand(cmd, fallbackRepo);
const repo = targetDir ? ctx.repoRootFromAnchor(targetDir, fallbackRepo) : fallbackRepo;
const branch = ctx.branchOf(repo);
// Clean up only when the commit verifiably landed: a marker exists AND HEAD advanced past the
// HEAD it recorded. If there is no marker (e.g. the SHIP_BYPASS path writes none) or HEAD is
// unchanged (commit rejected by husky), do NOT delete claimed-done — leave it for verify-stop,
// which inspects the working tree and will block a false "done".
const marker = ctx.readJSON(ctx.statePath(repo, "ship-ready", branch));
const head = ctx.sh("git rev-parse HEAD", repo);
const committed = marker && marker.head_sha && head && head !== marker.head_sha;
if (committed) {
  try { fs.unlinkSync(ctx.statePath(repo, "ship-ready", branch)); } catch (e) {}
  try { fs.unlinkSync(ctx.statePath(repo, "pass-approved", branch)); } catch (e) {}
  try { fs.unlinkSync(ctx.statePath(repo, "docs-updated", branch)); } catch (e) {}
  try { fs.unlinkSync(ctx.stateDir(repo, "claimed-done") + "/" + ctx.slug(branch)); } catch (e) {}
}
process.exit(0);
'
