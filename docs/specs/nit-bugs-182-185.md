# Spec: Nit-bug batch #182–#185

**Branch:** `chore/PLAT-182-nit-bugs-batch` (based on PR #181's tip — already contains `main`)
**Status:** ready for tasks

## Context

Four small, independent issues surfaced as non-blocking review observations on recent
PRs (#175, #177, #179, #180). Bundling them into one pass per user request rather than
four separate spec/PR cycles. Each is scoped to one file or one small group of sibling
files; none touch each other.

---

## §R — Requirements

- **R1** (#182, chore/worker): `apps/worker/package.json`'s `"hono"` specifier
  (`^4.5.0`) doesn't reflect the effective minimum pinned by `pnpm-workspace.yaml`'s
  override (`>=4.12.25`). Update the specifier to `^4.12.25` and add an inline comment
  pointing at the workspace override as source of truth, so the declared range isn't
  misleading.
- **R2** (#183, chore/dx): `.claude/hooks/lib/context.js`'s `repoRootFromAnchor` walks
  up the tree checking for `.git`'s existence (not directory-type) to survive git
  worktrees, where `.git` is a file, not a directory. Undocumented, so a future edit
  could "fix" it into an `isDirectory()` check and silently break worktree support. Add
  a one-line comment recording the intent.
- **R3** (#184, fix/api): filed as affecting `grant-access.ts`, `entity-detail.ts`,
  `entity-list.ts` — the latter two don't exist in this repo. Direct inspection of every
  `getWorkflow(tx, tenantId, instance.workflowId, {...})` call site (the
  workflow-admin-check pattern) found the real bug in **11** files: `grant-access.ts`,
  `update-access.ts`, `list-access-requests.ts`, `add-comment.ts`,
  `delete-comment-attachment.ts`, `revoke-access.ts`, `add-comment-attachment.ts`,
  `delete-attachment.ts`, `resolve-access-request.ts`, `create-attachment.ts`,
  `update.ts`. 9 of them funnel into the shared `apps/api/src/lib/handle-entity-error.ts`,
  which has no `WorkflowError` case, so a `WORKFLOW_NOT_FOUND` (thrown when the
  instance's workflow is deleted between the instance fetch and the admin-check fetch)
  falls to its generic 500 default. The other 2 (`add-comment.ts`, `update.ts`) call
  `getWorkflow` with no try/catch at all — fully uncaught. Fix: add one `WorkflowError`
  (`WORKFLOW_NOT_FOUND` → 404) case to `handleEntityError` (fixes the 9), and wrap the 2
  uncaught call sites in a local try/catch routed through the same `handleEntityError`.
  User explicitly approved this expanded scope over the literal 3-file issue text.
- **R4** (#185, refactor/entity-engine): `packages/entity-engine/src/engine.ts` inlines
  the literal `["open", "in-progress", "closed"]` (the child-ticket valid-state set) in
  **4** places, not the 2 the issue names — two branches inside `updateEntity` (~L484,
  ~L663) in addition to `bulkSetState` (~L1592) and `setEntityState` (~L1812). Extract
  one module-level `CHILD_TICKET_STATES` constant and point all four call sites at it,
  closing the full duplication rather than half of it. (Typed `readonly string[]`, not
  `as const` — the literal-tuple type from `as const` would force an unwanted type
  assertion at every `.includes()` call site.)

## §T — Task table (seed — expanded by /spec-tasks below)

| task                                                                       | requirement | status |
| -------------------------------------------------------------------------- | ----------- | ------ |
| T1: bump hono specifier + comment                                          | R1          | done   |
| T2: comment on repoRootFromAnchor                                          | R2          | done   |
| T3: WorkflowError→404 in handleEntityError + 2 uncaught call sites + tests | R3          | done   |
| T4: extract CHILD_TICKET_STATES, 4 call sites                              | R4          | done   |

## Out of scope

- No behavior change beyond the 404 fix in R3 (scope widened to its real 11-file/1-central-fix
  footprint, approved by user, but no new behavior beyond that same fix).
- No new abstractions beyond the single constant in R4.
- Not bundled into PR #181 (per user decision) — ships as its own PR off the same base commit.
