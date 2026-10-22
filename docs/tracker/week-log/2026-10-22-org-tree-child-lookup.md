# 2026-10-22 — Org chart showed only one level below the root

**Session type:** fix (docs/specs/org-directory.md, query API)
**Branch:** `fix/org-tree-child-lookup` (off `upstream/main`)

- **Symptom.** With a real tree (root, managers, leads, employees) the org chart page drew the
  root and its direct reports, and nothing below them.
- **Cause.** `getOrgTree` keyed `nodesByParentId` by each parent's row id (a surrogate uuid),
  but the page looks children up by `node.userId` (the auth-provider id). For the synthetic
  root the two are the same (its `userId` falls back to its row id), so level one rendered;
  for every real employee they differ, so every deeper level came back empty.
- **Fix.** Children are now keyed by the parent's `userId` (row id only for the root), and
  each node's `parentId` carries that same id. The search auto-expand, which walks up that
  parent chain, now works too. The pure builder is split out as `buildOrgTreeFromRows` so it
  can be unit tested without a database.
- **Tests.** `query-tree.test.ts`: children keyed by `userId` at every level, and no tree when
  there is no root.
- **Not changed.** `getChainToRoot` and `getReportsByLevel` already used row ids internally and
  take user ids as input, so they were correct.
