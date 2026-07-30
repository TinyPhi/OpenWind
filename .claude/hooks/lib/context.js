"use strict";
// context.js — shared helpers for the OpenWind guardrail hooks.
//
// Two problems this centralizes the fix for:
//  1. Hooks are spawned by the Claude Code harness with a FIXED cwd (the value of
//     CLAUDE_PROJECT_DIR) — the harness resets the session shell's cwd after every
//     Bash call, so a hook can never observe a `cd` an agent issued in an earlier
//     command. That means `git rev-parse --show-toplevel` run naively inside a hook
//     always resolves to the main checkout, even when the actual tool call targets a
//     file or git command in a separate `git worktree`. Fix: resolve repo root from
//     the concrete anchor the tool call gives us (a file path for Write/Edit, or an
//     explicit `-C <dir>` / leading `cd <dir> &&` in a Bash command string) instead of
//     from the hook's own inherited cwd.
//  2. `.claude/state/*.json` used to be one file per kind, shared across whatever
//     branch happened to be checked out — switching branches in the same working
//     directory silently clobbered another branch's plan/review/ship state. Fix:
//     key every state file by branch slug under its own subdirectory.
const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function sh(cmd, cwd) {
  try {
    return cp.execSync(cmd, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch (e) {
    return "";
  }
}

// RAW (untrimmed) output as a Buffer — use this, never `sh()`, as input to a hash.
// `sh()` trims for convenience (branch names, paths); trimming a diff before hashing
// makes the hash depend on incidental trailing-newline differences between callers,
// so two hooks that should agree on "does the staged diff match the marker" can
// silently disagree if one trims and the other doesn't.
function shBuf(cmd, cwd) {
  try {
    return cp.execSync(cmd, { cwd, stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    return Buffer.alloc(0);
  }
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function slug(branch) {
  return (branch || "unknown-branch").replace(/[^A-Za-z0-9._-]/g, "-");
}

// Walk up from `anchor` (a file or directory, possibly not yet existing) to the
// nearest existing ANCESTOR DIRECTORY, then ask git for that directory's worktree
// root. `execSync`'s `cwd` option requires a directory — passing an existing file
// path (the common case: Edit/Write always hand us a file) fails silently (ENOTDIR),
// so an existing file is dirname()'d before the existence walk, not after.
function repoRootFromAnchor(anchor, fallback) {
  if (!anchor) return fallback;
  let dir = anchor;
  try {
    if (!path.isAbsolute(dir)) dir = path.resolve(fallback || process.cwd(), dir);
    if (fs.existsSync(dir) && fs.statSync(dir).isFile()) dir = path.dirname(dir);
    while (dir && !fs.existsSync(dir)) {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch (e) {
    return fallback;
  }
  // Deliberately never stat `.git` ourselves here — in a worktree it's a file, not a
  // directory (a pointer back to the main repo's worktrees dir), so resolving the
  // toplevel is left to the `git` binary, which already handles both cases correctly.
  const root = sh("git rev-parse --show-toplevel", dir);
  return root || fallback;
}

// Path of `fp` relative to `repo`, robust to `repo` being a realpath'd form of a
// symlinked ancestor of `fp` (e.g. macOS resolves /tmp -> /private/tmp, so
// `git rev-parse --show-toplevel` returns /private/tmp/x while the tool's own
// file_path says /tmp/x — a plain string-prefix check would wrongly conclude fp
// is outside repo). Only the existing portion of fp is realpath'd; a
// not-yet-created leaf (Write creating a new file) is reattached as-is.
function relPath(repo, fp) {
  let target = fp;
  try {
    if (fs.existsSync(target)) {
      target = fs.realpathSync(target);
    } else {
      const dir = path.dirname(target);
      target = fs.existsSync(dir) ? path.join(fs.realpathSync(dir), path.basename(target)) : target;
    }
  } catch (e) {}
  let root = repo;
  try { root = fs.realpathSync(repo); } catch (e) {}
  return path.relative(root, target);
}

// Detect an explicit target directory in a shell command string: a leading
// `cd <dir> &&`/`cd <dir>;` before the git invocation, or a `git -C <dir>` flag.
// Returns an absolute, existing directory, or null if the command carries no
// explicit redirection (the ordinary case — operate on baseDir as before).
function targetDirFromCommand(cmd, baseDir) {
  if (!cmd) return null;
  let dir = null;
  // Take the LAST `cd` in a chain (e.g. `cd /a && cd /b && git commit` targets /b,
  // resolved relative to /a — not the first hop).
  // Trailing terminator is a lookahead (not consumed): a consuming match would eat the
  // "&&"/";" a SUBSEQUENT `cd` needs as ITS leading anchor, breaking detection of the
  // second hop in a chain like `cd /a && cd /b && ...`.
  const cdRe = /(?:^|[;&\n])\s*cd\s+(?:--\s+)?(['"]?)(\S+?)\1(?=\s*(?:&&|;|\n|$))/g;
  let m, last = null, cursor = baseDir;
  while ((m = cdRe.exec(cmd)) !== null) {
    const resolved = path.isAbsolute(m[2]) ? m[2] : path.resolve(cursor, m[2]);
    last = resolved;
    cursor = resolved;
  }
  if (last) dir = last;
  const cFlagMatch = cmd.match(/\bgit\b(?:\s+-c\s+\S+)*\s+-C\s+(['"]?)(\S+?)\1\b/);
  if (cFlagMatch) dir = path.isAbsolute(cFlagMatch[2]) ? cFlagMatch[2] : path.resolve(dir || baseDir, cFlagMatch[2]);
  if (!dir) return null;
  const resolved = path.isAbsolute(dir) ? dir : path.resolve(baseDir, dir);
  return fs.existsSync(resolved) ? resolved : null;
}

function branchOf(repo) {
  return sh("git rev-parse --abbrev-ref HEAD", repo);
}

function stateDir(repo, kind) {
  return path.join(repo, ".claude", "state", kind);
}

function statePath(repo, kind, branch) {
  return path.join(stateDir(repo, kind), slug(branch) + ".json");
}

function ensureStateDir(repo, kind) {
  try {
    fs.mkdirSync(stateDir(repo, kind), { recursive: true });
  } catch (e) {}
}

function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return null;
  }
}

function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

// All linked worktrees for `repo` (including the main one), as absolute paths.
function listWorktrees(repo) {
  const raw = sh("git worktree list --porcelain", repo);
  if (!raw) return [repo];
  const dirs = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) dirs.push(line.slice("worktree ".length).trim());
  }
  return dirs.length ? dirs : [repo];
}

module.exports = {
  sh,
  shBuf,
  sha256,
  slug,
  repoRootFromAnchor,
  relPath,
  targetDirFromCommand,
  branchOf,
  stateDir,
  statePath,
  ensureStateDir,
  readJSON,
  writeJSON,
  listWorktrees,
};
