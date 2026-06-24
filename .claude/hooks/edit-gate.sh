#!/usr/bin/env bash
# edit-gate.sh — PreToolUse(Write|Edit)
# Hard-blocks edits to source (apps/ packages/ modules/) unless a human-APPROVED
# plan-lock exists for the current branch. Realises the "Code stage needs the Plan".
# Node does the logic (matches repo convention; no jq dependency). Exit 2 = block.
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
if (!/^(apps|packages|modules)\//.test(rel)) process.exit(0);
function ensureDir() { try { fs.mkdirSync(repo + "/.claude/state", { recursive: true }); } catch (e) {} }
if (process.env.OPENWIND_GATE === "off") {
  ensureDir();
  try { fs.appendFileSync(repo + "/.claude/state/bypass.log", new Date().toISOString() + " edit-gate OPENWIND_GATE=off " + rel + "\n"); } catch (e) {}
  process.exit(0);
}
let branch = "";
try { branch = cp.execSync("git rev-parse --abbrev-ref HEAD", { cwd: repo }).toString().trim(); } catch (e) {}
let plan = null;
try { plan = JSON.parse(fs.readFileSync(repo + "/.claude/state/plan.json", "utf8")); } catch (e) {}
const ok = plan && plan.branch === branch && plan.approved === true;
if (ok) process.exit(0);
const reason = !plan ? "no plan-lock exists for this branch"
  : plan.branch !== branch ? ("plan-lock is for branch " + plan.branch + ", not " + branch)
  : "a plan-lock exists but is not human-approved yet";
process.stderr.write(
  "EDIT GATE - blocked editing " + rel + "\n" +
  "Reason: " + reason + ".\n" +
  "Agree and FREEZE a plan before editing source: run /spec-tasks (or the openwind-loop pick step) to\n" +
  "draft acceptance criteria + scope, then get explicit human approval (the freeze writes approved:true).\n" +
  "One-off bypass (logged): OPENWIND_GATE=off\n"
);
process.exit(2);
'
