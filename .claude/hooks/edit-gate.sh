#!/usr/bin/env bash
# edit-gate.sh — PreToolUse(Write|Edit)
# Hard-blocks edits to source (apps/ packages/ modules/) unless a human-APPROVED
# plan-lock exists for the current branch. Realises the "Code stage needs the Plan".
# Node does the logic (matches repo convention; no jq dependency). Exit 2 = block.
#
# Worktree-aware: repo root is resolved from the FILE BEING EDITED, not from this
# hook's own inherited cwd. The harness always spawns hooks with cwd == the main
# checkout (it resets the session shell's cwd after every Bash call), so a naive
# `git rev-parse --show-toplevel` here would silently resolve to the wrong repo -
# and thus check the wrong plan-lock - for edits inside a `git worktree`. See
# .claude/hooks/lib/context.js for the shared resolution logic, and plan-lock state
# is keyed by branch (.claude/state/plan/<branch-slug>.json) so switching branches
# in the same working directory no longer clobbers another branch's plan.
FALLBACK_REPO="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-$PWD}")"
export FALLBACK_REPO
export LIBDIR="${CLAUDE_PROJECT_DIR:-$FALLBACK_REPO}/.claude/hooks/lib"
exec node -e '
const fs = require("fs");
const ctx = require(process.env.LIBDIR + "/context.js");
const fallbackRepo = process.env.FALLBACK_REPO;
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch (e) {}
const tool = input.tool_name || "";
if (tool !== "Write" && tool !== "Edit") process.exit(0);
const ti = input.tool_input || {};
const fp = ti.file_path || input.file_path || "";
if (!fp) process.exit(0);
const repo = ctx.repoRootFromAnchor(fp, fallbackRepo);
const rel = ctx.relPath(repo, fp);
// Only gate real source/schema files under the source roots - docs/config (.md, .json,
// .env.example, etc.) under apps/packages/modules edit freely without a plan-lock.
if (!/^(apps|packages|modules)\/.*\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|sql)$/.test(rel)) process.exit(0);
// Tests edit freely - writing a test should never require a plan-lock. verify-stop still
// requires tests committed before "done", so this stays consistent with that hook.
if (/\.(test|spec)\.[tj]sx?$|(^|\/)(tests?|__tests__)\//.test(rel)) process.exit(0);
if (process.env.OPENWIND_GATE === "off") {
  ctx.ensureStateDir(repo, "plan");
  try { fs.appendFileSync(repo + "/.claude/state/bypass.log", new Date().toISOString() + " edit-gate OPENWIND_GATE=off " + rel + " (repo=" + repo + ")\n"); } catch (e) {}
  process.exit(0);
}
const branch = ctx.branchOf(repo);
const plan = ctx.readJSON(ctx.statePath(repo, "plan", branch));
const planExists = plan && plan.branch === branch;
// Graduated-trust mode, mirrors the OPENWIND_AUTOPASS toggle in commit-gate: the plan-lock
// artifact still has to exist (agent must have run /spec-tasks and scoped the work), it just
// is not required for the human to type "approve-plan" for it. Not logged to bypass.log --
// unlike OPENWIND_GATE=off, this is not skipping a check, it is the owner standing trust grant.
const autopass = process.env.OPENWIND_PLAN_AUTOPASS === "1";
const ok = planExists && (plan.approved === true || autopass);
if (ok) process.exit(0);
const reason = !planExists ? "no plan-lock exists for this branch"
  : "a plan-lock exists but is not human-approved yet";
process.stderr.write(
  "EDIT GATE - blocked editing " + rel + " (repo: " + repo + ", branch: " + branch + ")\n" +
  "Reason: " + reason + ".\n" +
  "Agree and FREEZE a plan before editing source: run /spec-tasks (or the openwind-loop pick step) to\n" +
  "draft acceptance criteria + scope, then get explicit human approval (the freeze writes approved:true).\n" +
  "Skip only the human blessing (plan-lock still required): OPENWIND_PLAN_AUTOPASS=1\n" +
  "One-off full bypass (logged, no plan-lock required at all): OPENWIND_GATE=off\n"
);
process.exit(2);
'
