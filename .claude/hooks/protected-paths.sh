#!/usr/bin/env bash
# protected-paths.sh — PreToolUse(Write|Edit)
# Hard-blocks edits the repo declares off-limits / human-owned:
#   - any edit while on main/develop (integration branches)
#   - *.ts / *.tsx under modules/ (config-first rule, ADR-004)
#   - docs/decisions/ADR* (ADRs are human-written)
#   - .github/workflows/* (all CI/CD files)
#   - secret .env files (.env, .env.local, .env.production, etc.) — .env.example is allowed
# Mirrors documented rules + CI, so it is never arbitrary. Exit 2 = block.
REPO="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-$PWD}")"
export REPO
exec node -e '
const fs = require("fs");
const cp = require("child_process");
const repo = process.env.REPO;
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch (e) {}
const tool = input.tool_name || "";
if (tool !== "Write" && tool !== "Edit") process.exit(0);
const ti = input.tool_input || {};
const fp = ti.file_path || input.file_path || "";
if (!fp) process.exit(0);
let rel = fp;
if (rel.indexOf(repo) === 0) rel = rel.slice(repo.length).replace(/^\/+/, "");
function ensureDir() { try { fs.mkdirSync(repo + "/.claude/state", { recursive: true }); } catch (e) {} }
function bypassed(envName) {
  const v = process.env[envName];
  const on = (envName === "OPENWIND_OFFLIMITS" && v === "ack") || (envName === "OPENWIND_ALLOW_MODULE_TS" && v === "1");
  if (on) { ensureDir(); try { fs.appendFileSync(repo + "/.claude/state/bypass.log", new Date().toISOString() + " protected-paths " + envName + " " + rel + "\n"); } catch (e) {} }
  return on;
}
function block(msg, bypassEnv) {
  process.stderr.write("PROTECTED PATH - blocked editing " + rel + "\n" + msg + "\n" + (bypassEnv ? ("Human-directed bypass (logged): " + bypassEnv + "\n") : ""));
  process.exit(2);
}
let branch = "";
try { branch = cp.execSync("git rev-parse --abbrev-ref HEAD", { cwd: repo }).toString().trim(); } catch (e) {}
if (branch === "main" || branch === "develop") {
  block("These are integration branches. Create a feat/ fix/ chore/ docs/ test/ branch off main first.", null);
}
if (/^modules\/.+\.(ts|tsx)$/.test(rel) && !/(^|\/)index\.tsx?$/.test(rel)) {
  if (!bypassed("OPENWIND_ALLOW_MODULE_TS")) block("Config-first (ADR-004): modules/ is seed SQL only - no TypeScript LOGIC (a one-line stub index.ts is allowed). Express this as engine config / seed SQL, or add a missing engine capability via an engine PR.", "OPENWIND_ALLOW_MODULE_TS=1");
  process.exit(0);
}
if (/^docs\/decisions\/ADR/i.test(rel)) {
  if (!bypassed("OPENWIND_OFFLIMITS")) block("ADRs are human-written (CLAUDE.md off-limits).", "OPENWIND_OFFLIMITS=ack");
  process.exit(0);
}
if (/^\.github\/workflows\//.test(rel)) {
  if (!bypassed("OPENWIND_OFFLIMITS")) block("CI/CD workflows are off-limits to autonomous edits - a workflow can exfiltrate secrets or disable required checks (CLAUDE.md off-limits). (CODEOWNERS is the real protection for `.github/` and `scripts/`.)", "OPENWIND_OFFLIMITS=ack");
  process.exit(0);
}
if ((/(^|\/)\.env(\.|$)/.test(rel) || /\.env$/.test(rel) || /\.env\.[\w-]+$/.test(rel)) && !/\.env\.example$/.test(rel)) {
  block("Never write secrets/.env files (incl. prod.env, local.env). Use @platform/config + the secrets manager. (.env.example is allowed - it is a checked-in template)", null);
}
process.exit(0);
'
