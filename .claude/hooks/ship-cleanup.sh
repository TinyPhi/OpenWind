#!/usr/bin/env bash
# ship-cleanup.sh — PostToolUse(Bash)
# One-shot: after a `git commit` runs, delete the ship marker so it can never be
# reused for a second commit. Also clears the claimed-done sentinel (pipeline finished).
REPO="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-$PWD}")"
export REPO
exec node -e '
const fs = require("fs");
const repo = process.env.REPO;
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch (e) {}
if ((input.tool_name || "") !== "Bash") process.exit(0);
const cmd = (input.tool_input && input.tool_input.command) || "";
function gitSub(c, s) {
  const re = /\bgit\b((?:\s+(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?|-[A-Za-z]+))*)\s+([a-z][a-z-]*)/g;
  let m; while ((m = re.exec(c)) !== null) { if (m[2] === s) return true; } return false;
}
if (!gitSub(cmd, "commit")) process.exit(0);
for (const f of ["ship-ready.json", "claimed-done"]) {
  try { fs.unlinkSync(repo + "/.claude/state/" + f); } catch (e) {}
}
process.exit(0);
'
