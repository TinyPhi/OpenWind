#!/usr/bin/env bash
# commit-gate.sh — PreToolUse(Bash)
# Hard-blocks `git commit` unless ALL of these are fresh for this branch:
#   - ship-ready.json    (staged_tree_sha matches `git diff --staged`, age <= 60m)
#   - review.json        (diff_sha matches `git diff HEAD` — review covers the committed code)
#   - docs-updated.json  (diff_sha matches `git diff HEAD` — docs kept in sync, or an explicit skip reason)
# Realises the "Ship stage needs a passing Review + Docs + marker". Exit 2 = block.
#
# Worktree-aware: this hook is spawned with cwd == the main checkout regardless of what
# the actual Bash command targets (the harness resets the session shell's cwd after every
# call, so it never reflects a `cd` embedded in an earlier command). If THIS command
# redirects git to another working tree via a leading `cd <dir> &&` or `git -C <dir>`,
# resolve repo root and branch from there instead — otherwise a commit made inside a
# worktree would be checked against the main checkout's (unrelated) state files.
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
// Match a real `git commit` INVOCATION: commit must be the subcommand (only global
// flags may sit between `git` and `commit`) - not any command that merely mentions both.
function gitSub(c, s) {
  const re = /\bgit\b((?:\s+(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?|-[A-Za-z]+))*)\s+([a-z][a-z-]*)/g;
  let m; while ((m = re.exec(c)) !== null) { if (m[2] === s) return true; } return false;
}
// Strip QUOTED SPANS (their content is data: messages, grep patterns, echo text) before detecting a
// real subcommand - so `grep "git commit"` / `echo "...git commit..."` are not treated as commits.
const noStr = cmd.replace(/"[^"]*"/g, " ").replace(/\x27[^\x27]*\x27/g, " ");
if (!gitSub(noStr, "commit")) process.exit(0);
if (/--help\b|\s-h\b|--version\b/.test(cmd)) process.exit(0);
const targetDir = ctx.targetDirFromCommand(cmd, fallbackRepo);
const repo = targetDir ? ctx.repoRootFromAnchor(targetDir, fallbackRepo) : fallbackRepo;
function ensureDir() { try { fs.mkdirSync(repo + "/.claude/state", { recursive: true }); } catch (e) {} }
if (process.env.SHIP_BYPASS === "1" || /(?:^|[;&|]|\s)SHIP_BYPASS=1\s+(?:[A-Za-z_]\w*=\S+\s+)*git\b/.test(cmd)) {
  ensureDir();
  try { fs.appendFileSync(repo + "/.claude/state/bypass.log", new Date().toISOString() + " commit-gate SHIP_BYPASS=1 " + cmd.slice(0, 200) + " (repo=" + repo + ")\n"); } catch (e) {}
  process.exit(0);
}
function sha(gitArgs) {
  return ctx.sha256(ctx.shBuf("git " + gitArgs, repo));
}
const branch = ctx.branchOf(repo);
const fails = [];
// Marker
const marker = ctx.readJSON(ctx.statePath(repo, "ship-ready", branch));
if (!marker) fails.push("no ship marker (run the commit procedure: it writes the marker right before commit)");
else {
  const ageMin = (Date.now() - Date.parse(marker.timestamp_iso || 0)) / 60000;
  if (!(ageMin <= 60)) fails.push("ship marker is " + Math.round(ageMin) + " min old (>60); re-run the commit procedure");
  else if (marker.staged_tree_sha !== sha("diff --staged")) fails.push("staged tree changed since the marker was written; re-stage and re-run the commit procedure");
}
// Everything must be staged: the reviewed tree (diff HEAD) must equal the committed tree
// (diff --staged), so the review covers exactly what lands. Blocks partial/forgotten staging.
if (sha("diff HEAD") !== sha("diff --staged")) fails.push("unstaged changes present - stage or stash them so the review covers exactly what is committed");
// Review
const review = ctx.readJSON(ctx.statePath(repo, "review", branch));
if (!review) fails.push("no review record (run /review before committing)");
else if (review.diff_sha !== sha("diff HEAD")) fails.push("code changed since the last review; re-run /review against the final diff");
else if (review.dod_met !== true) fails.push("Definition-of-Done not affirmatively met (dod_met must be true): " + (review.dod_unmet || []).join(", "));
// Docs — every commit either touches docs or explicitly justifies why not, so docs
// never silently drift out of sync with the code landing alongside them.
const docs = ctx.readJSON(ctx.statePath(repo, "docs-updated", branch));
if (!docs) fails.push("no docs marker (run write-docs-marker.sh --touched, or --skip \"<reason>\", before committing)");
else if (docs.branch !== branch) fails.push("docs marker is for branch " + docs.branch);
else if (docs.diff_sha !== sha("diff HEAD")) fails.push("code changed since the docs marker was written; re-run write-docs-marker.sh against the final diff");
// Human pass-approval (the second checkpoint) - only the approval-gate (a human typing
// "approve-ship") writes pass-approved/<branch>.json - so the agent should not casually
// self-approve (best-effort guardrail, not a hard guarantee). Skipped only when
// the owner has graduated to auto-pass (OPENWIND_AUTOPASS=1).
if (process.env.OPENWIND_AUTOPASS !== "1") {
  const pa = ctx.readJSON(ctx.statePath(repo, "pass-approved", branch));
  if (!pa) fails.push("no human pass-approval - a human must type 'approve-ship' in chat (or the owner sets OPENWIND_AUTOPASS=1)");
  else if (pa.diff_sha !== sha("diff HEAD")) fails.push("code changed since the human approved the pass; ask for 'approve-ship' again");
}
if (fails.length === 0) process.exit(0);
process.stderr.write(
  "COMMIT GATE - blocked git commit on " + branch + " (repo: " + repo + ")\n- " + fails.join("\n- ") + "\n" +
  "Complete the pipeline: finish all edits -> /review (writes review.json) -> write-docs-marker.sh -> write-ship-marker.sh -> commit.\n" +
  "Bootstrap/hotfix bypass (logged): SHIP_BYPASS=1 git commit ...\n"
);
process.exit(2);
'
