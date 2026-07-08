#!/usr/bin/env bash
# destructive-guard.sh — PreToolUse(Bash)
# A GUARDRAIL, not a barricade. Blocks the common destructive command forms so honest mistakes and
# casual agent actions are stopped early. It matches the command text with quotes stripped, so
# simple quoted/spaced evasions (e.g. rm -rf "/") are still caught. It is best-effort by nature:
# a determined agent can bypass it (variable indirection, wrapper scripts like `bash x.sh`, or
# other tools). The real safety net is CI + human review + branch protection, NOT this hook.
REPO="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-$PWD}")"
export REPO
exec node -e '
const fs = require("fs");
const repo = process.env.REPO;
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch (e) {}
if ((input.tool_name || "") !== "Bash") process.exit(0);
const raw = (input.tool_input && input.tool_input.command) || "";
const cmd = raw.replace(/[\x27\x22]/g, " "); // strip quotes so "/", "$HOME" etc cannot hide a target
function block(msg) {
  process.stderr.write("DESTRUCTIVE GUARD - blocked.\n" + msg + "\nIf this is genuinely required, run it yourself in a plain terminal.\n");
  process.exit(2);
}
// rm with BOTH recursive and force (any flag form), targeting a risky path or a glob
const rmRecursive = /\brm\b[^|;&]*(?:\s-[A-Za-z]*r[A-Za-z]*\b|\s--recursive\b)/.test(cmd);
const rmForce = /\brm\b[^|;&]*(?:\s-[A-Za-z]*f[A-Za-z]*\b|\s--force\b)/.test(cmd);
if (rmRecursive && rmForce) {
  if (/\brm\s+[^\n]*\s(\/|~|\$HOME|\.git\b|\*|\.\.(\/|\s|$)|\s\.\s|\s\.$)/.test(cmd) ||
      /\brm\s+-[a-zA-Z]*\s+(\/|~|\.|\*)\s*$/.test(cmd) ||
      /\brm\s[^|;&]*\s\.\/(\*|\s|$)/.test(cmd)) {
    block("rm -rf targeting a risky path (root, home, repo root, .git, cwd, or a bare glob).");
  }
}
// Other irreversible mass-delete tools
if (/\bfind\b[^|;&]*\s-delete\b/.test(cmd)) block("find -delete (mass delete).");
if (/\btruncate\b[^|;&]*\s-s\s*0\b/.test(cmd)) block("truncate -s 0 (destroys file contents).");
if (/\bshred\b/.test(cmd)) block("shred (irreversible destroy).");
// SQL destructive (allow inside a migration file)
if (/\bDROP\s+DATABASE\b/i.test(cmd)) block("DROP DATABASE.");
if (/\b(DROP\s+TABLE|TRUNCATE\s+TABLE)\b/i.test(cmd) && !/migration|\.sql\b/i.test(cmd)) {
  block("DROP TABLE / TRUNCATE TABLE outside a migration file.");
}
// git history / verify hazards. Strip quoted spans (the commit message is data) so -n/--no-verify is
// matched only as a real flag, wherever it sits relative to -m (truncating at -m missed flags AFTER it).
const noVerifyScan = raw.replace(/"[^"]*"/g, " ").replace(/\x27[^\x27]*\x27/g, " ");
if (/\bgit\s+commit\b[^|;&]*(--no-verify|\s-[A-Za-z]*n[A-Za-z]*\b)/.test(noVerifyScan)) block("git commit --no-verify (incl. combined short flags like -anm) bypasses husky/commitlint. Fix the issue instead.");
if (/\bgit\s+push\b[^|;&]*(--force\b|--force-with-lease\b|\s-f\b|\s\+[A-Za-z0-9._\/@^~-]+(:[A-Za-z0-9._\/@^~-]+)?)/.test(cmd)) block("git push force-update (--force / -f / --force-with-lease / +refspec) can overwrite published history.");
process.exit(0);
'
