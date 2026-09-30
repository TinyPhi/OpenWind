# 2026-09-29 — protected-paths hook resolves the edited file's worktree

**Session type:** Guardrail hook fix
**Branch:** `fix/protected-paths-worktree-branch`

## Problem

`.claude/hooks/protected-paths.sh` resolved everything from the main checkout, the directory the
harness spawns hooks in, instead of from the file being edited. Two consequences:

- **False block.** With the main checkout on `main`, every `Write`/`Edit` was refused as "editing
  an integration branch", including edits in a linked worktree on a `fix/` branch and files
  outside any repo (scratch files). This blocked review fixes in the advisory worktrees today.
- **Silent fail-open.** For a file in a linked worktree, the path stayed absolute, so the anchored
  rules (`^docs/decisions/ADR`, `^modules/…\.ts`, `^.github/workflows/`) never matched. ADRs,
  workflows and module TypeScript in worktrees were unprotected.

## Fix

- It now uses the same helpers as `edit-gate.sh` (`repoRootFromAnchor`, `relPath`, `branchOf`
  in `.claude/hooks/lib/context.js`). The repo, the relative path and the integration-branch check
  all come from the edited file's own worktree.
- A file outside every repo is not governed.
- `.claude/README.md` lists `protected-paths` among the worktree-aware hooks.

## Verification

- `scripts/test-claude-hooks.sh` gains six cases:
  - a file outside every repo is allowed;
  - a worktree checked out on `develop` is blocked, while the main checkout on a work branch is
    not;
  - the ADR and workflow rules apply inside a worktree;
  - an ordinary file in a work-branch worktree is allowed.
- With the fix, all 68 cases pass. With the old hook, the three worktree cases fail.
- The new cases build their JSON with `printf`, because a quoted `"{a,b}"` literal inside `$(…)`
  was split by bash at the comma.

## Review round 1 (PrabhuVijit)

- The integration-branch worktree case now uses an explicit `if` / `elif` / `else`: skip if
  `develop` exists, skip if the worktree can't be created, otherwise test. Behaviour is unchanged.
- **Kept:**
  - The week-log stays in `docs/tracker/week-log/`. That is the tracked location (44 entries on
    `main`, named in CLAUDE.md). `docs/sup-docs/` is gitignored and must not hold tracking
    content.
  - Temp-dir cleanup stays `rmdir`. CI runners are ephemeral, and the destructive guard steers
    away from `rm -rf` on variable paths.
