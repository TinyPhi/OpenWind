#!/usr/bin/env bash
# destructive-guard.sh — PreToolUse(Bash)
# Hard-blocks irreversible/dangerous commands before they run:
#   - rm -rf on risky targets (/, ~, repo root, .git, globs)
#   - DROP DATABASE / DROP TABLE / TRUNCATE executed (not inside a migration .sql)
#   - git commit --no-verify (dodges husky/commitlint), git push --force
# Hard block (no env bypass) — these are the "you cannot undo this" class. Exit 2 = block.
REPO="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-$PWD}")"
export REPO
exec node -e '
const fs = require("fs");
const repo = process.env.REPO;
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch (e) {}
if ((input.tool_name || "") !== "Bash") process.exit(0);
const cmd = (input.tool_input && input.tool_input.command) || "";
function block(msg) {
  process.stderr.write("DESTRUCTIVE GUARD - blocked.\n" + msg + "\nIf this is genuinely required, run it yourself in a plain terminal.\n");
  process.exit(2);
}
// rm -rf on risky targets
const rmRecursive = /\brm\b[^|;&]*(?:\s-[A-Za-z]*r[A-Za-z]*\b|\s--recursive\b)/.test(cmd);
const rmForce = /\brm\b[^|;&]*(?:\s-[A-Za-z]*f[A-Za-z]*\b|\s--force\b)/.test(cmd);
if (rmRecursive && rmForce) {
  if (/\brm\s+[^\n]*\s(\/|~|\$HOME|\.git\b|\*|\.\.\/|\s\.\s|\s\.$)/.test(cmd) || /\brm\s+-[a-zA-Z]*\s+(\/|~|\.|\*)\s*$/.test(cmd)) {
    block("rm -rf targeting a risky path (root, home, repo root, .git, or a glob).");
  }
}
// DROP / TRUNCATE executed against a DB (allow when clearly editing a migration file)
if (/\bDROP\s+DATABASE\b/i.test(cmd)) block("DROP DATABASE.");
if (/\b(DROP\s+TABLE|TRUNCATE)\b/i.test(cmd) && !/migration|\.sql\b/i.test(cmd)) {
  block("DROP TABLE / TRUNCATE outside a migration file.");
}
if (/\bgit\s+commit\b[^|;&]*(--no-verify|\s-[A-Za-z]*n[A-Za-z]*\b)/.test(cmd)) block("git commit --no-verify (incl. combined short flags like -anm) bypasses husky/commitlint. Fix the issue instead.");
if (/\bgit\s+push\b[^|;&]*(--force\b|--force-with-lease\b|\s-f\b|\s\+[A-Za-z0-9._\/@^~-]+(:[A-Za-z0-9._\/@^~-]+)?)/.test(cmd)) block("git push force-update (--force / -f / --force-with-lease / +refspec) can overwrite published history.");
process.exit(0);
'
