#!/usr/bin/env bash
# verify-stop.sh — Stop
# Backstop against a FALSE "done": only acts when the agent has written a
# .claude/state/claimed-done sentinel (it asserted the unit is complete). It then does
# a CHEAP pipeline-completion check (is source still uncommitted?) — it does NOT re-run
# typecheck/lint (the commit step already owns verification; re-running is wasted cost).
# Never fires on a normal mid-task pause (no sentinel => allow). Exit 2 = block the stop.
REPO="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-$PWD}")"
export REPO
exec node -e '
const fs = require("fs");
const cp = require("child_process");
const repo = process.env.REPO;
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch (e) {}
// Avoid re-entrancy loops: if this Stop is already a hook continuation, allow.
if (input.stop_hook_active === true) process.exit(0);
let sentinel = false;
try { fs.accessSync(repo + "/.claude/state/claimed-done"); sentinel = true; } catch (e) {}
if (!sentinel) process.exit(0);
let dirty = "";
try { dirty = cp.execSync("git status --porcelain -- apps packages modules tests", { cwd: repo }).toString().trim(); } catch (e) {}
if (!dirty) { try { fs.unlinkSync(repo + "/.claude/state/claimed-done"); } catch (e) {} process.exit(0); }
process.stderr.write(
  "VERIFY-STOP - you claimed done, but the pipeline did not complete.\n" +
  "Uncommitted source changes remain:\n" + dirty.split("\n").slice(0, 12).join("\n") + "\n" +
  "Finish the commit procedure (all edits -> /review -> marker -> commit), or if you are intentionally\n" +
  "pausing mid-work, clear the claim: rm .claude/state/claimed-done\n"
);
process.exit(2);
'
