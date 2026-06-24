#!/usr/bin/env bash
# commit-gate.sh — PreToolUse(Bash)
# Hard-blocks `git commit` unless BOTH are fresh for this branch:
#   - ship-ready.json   (staged_tree_sha matches `git diff --staged`, age <= 30m)
#   - review.json       (diff_sha matches `git diff HEAD` — review covers the committed code)
# Realises the "Ship stage needs a passing Review + marker". Exit 2 = block.
REPO="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-$PWD}")"
export REPO
exec node -e '
const fs = require("fs");
const cp = require("child_process");
const crypto = require("crypto");
const repo = process.env.REPO;
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
if (!gitSub(cmd, "commit")) process.exit(0);
if (/--help\b|\s-h\b|--version\b/.test(cmd)) process.exit(0);
function ensureDir() { try { fs.mkdirSync(repo + "/.claude/state", { recursive: true }); } catch (e) {} }
if (process.env.SHIP_BYPASS === "1" || /\bSHIP_BYPASS=1\b/.test(cmd)) {
  ensureDir();
  try { fs.appendFileSync(repo + "/.claude/state/bypass.log", new Date().toISOString() + " commit-gate SHIP_BYPASS=1 " + cmd.slice(0, 200) + "\n"); } catch (e) {}
  process.exit(0);
}
function sha(gitArgs) {
  try { return crypto.createHash("sha256").update(cp.execSync("git " + gitArgs, { cwd: repo })).digest("hex"); }
  catch (e) { return null; }
}
let branch = "";
try { branch = cp.execSync("git rev-parse --abbrev-ref HEAD", { cwd: repo }).toString().trim(); } catch (e) {}
function readJSON(p) { try { return JSON.parse(fs.readFileSync(repo + "/.claude/state/" + p, "utf8")); } catch (e) { return null; } }
const fails = [];
// Marker
const marker = readJSON("ship-ready.json");
if (!marker) fails.push("no ship marker (run the commit procedure: it writes the marker right before commit)");
else if (marker.branch !== branch) fails.push("ship marker is for branch " + marker.branch);
else {
  const ageMin = (Date.now() - Date.parse(marker.timestamp_iso || 0)) / 60000;
  if (!(ageMin <= 30)) fails.push("ship marker is " + Math.round(ageMin) + " min old (>30); re-run the commit procedure");
  else if (marker.staged_tree_sha !== sha("diff --staged")) fails.push("staged tree changed since the marker was written; re-stage and re-run the commit procedure");
}
// Review
const review = readJSON("review.json");
if (!review) fails.push("no review record (run /review before committing)");
else if (review.branch !== branch) fails.push("review is for branch " + review.branch);
else if (review.diff_sha !== sha("diff HEAD")) fails.push("code changed since the last review; re-run /review against the final diff");
else if (review.dod_met === false) fails.push("Definition-of-Done not met: " + (review.dod_unmet || []).join(", "));
if (fails.length === 0) process.exit(0);
process.stderr.write(
  "COMMIT GATE - blocked git commit on " + branch + "\n- " + fails.join("\n- ") + "\n" +
  "Complete the pipeline: finish all edits -> /review (writes review.json) -> write-ship-marker.sh -> commit.\n" +
  "Bootstrap/hotfix bypass (logged): SHIP_BYPASS=1 git commit ...\n"
);
process.exit(2);
'
