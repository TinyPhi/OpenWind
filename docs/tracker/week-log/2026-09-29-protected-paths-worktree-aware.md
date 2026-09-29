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
