# 2026-09-29 — fast-uri pin raised; approval gate accepts a branch name

**Session type:** Dependency fix + guardrail hook fix
**Branch:** `fix/fast-uri-authority-advisories`

## fast-uri (CI security scan failing on `main`)

- On 2026-09-28, two high advisories were published against `fast-uri`, which reaches the tree
  only through commitlint (`@commitlint/config-validator > ajv > fast-uri`):
  GHSA-qw65-cvwx-89v3 (authority injection via an unvalidated port) and GHSA-58mr-gqgx-xq4g
  (host confusion via an unclosed bracket). The existing override allowed `4.1.3`, which is
  affected. The "Audit dependencies" step (`pnpm audit --audit-level=high`) failed on `main`
  after #706 and #702 merged.
- The override in `pnpm-workspace.yaml` is now `>=3.1.7 <4.0.0 || >=4.1.4`, with an inline
  advisory comment. The lockfile resolves `4.2.1`.
- Result: `pnpm audit --audit-level=high` reports no high findings (7 moderate findings predate
  this change). commitlint still accepts valid messages and rejects invalid ones.

## approval-gate: `approve-plan <branch>` / `approve-ship <branch>`

- With more than one pending plan-lock or ship marker across the main checkout and worktrees,
  the hook replied "say which branch to approve", but it never read a branch name from the
  prompt, so there was no way to resolve the ambiguity from chat. That happened today with stale
  plan-locks in two linked worktrees.
- The word after the directive now narrows the candidates to that exact branch. It counts as a
  branch only if it contains `/` or exactly matches a pending branch, so
  `please approve-plan now` behaves as before. A name that matches nothing approves nothing.
- `scripts/test-claude-hooks.sh` gains five cases, using a second worktree with its own pending
  plan-lock: bare approval approves neither; the ambiguity message shows the syntax; the named
  branch alone is approved; an unknown branch approves nothing; a non-branch word does not pick.
- Locally, three older cases fail because this machine has two unrelated worktrees with pending
  plan-locks, which makes a bare `approve-plan` ambiguous. CI has no extra worktrees.
