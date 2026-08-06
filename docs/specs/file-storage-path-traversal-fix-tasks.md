# Implementation Plan: Fix path traversal / arbitrary file write in local-disk file storage

**Spec:** docs/specs/file-storage-path-traversal-fix.md
**Generated:** 2026-07-28
**Status:** implemented, pending review

---

## Phase 1 — Boundary validation

**Goal:** Reject malicious `moduleSlug` values before they ever reach storage-path construction.
**Gate:** existing `apps/api` file-route tests pass + new traversal-payload tests pass → then Phase 2

| task                                                                                                                       | requirement | status |
| -------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T1: Restrict `moduleSlug` to `z.string().min(1).max(100).regex(/^[a-z0-9-]+$/)` in `apps/api/src/routes/files/initiate.ts` | R1          | done   |

---

## Phase 2 — Defense-in-depth containment

**Goal:** Ensure `resolveStoragePath()` can never resolve outside `env.FILES_STORAGE_PATH`, independent of upstream validation.
**Gate:** `@platform/files` unit tests pass + Phase 1 gate still green → then Phase 3

| task                                                                                                                               | requirement | status |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T2: Add `STORAGE_PATH_ESCAPE` to `FileErrorCode` in `packages/files/src/errors.ts`                                                 | R2          | done   |
| T3: Rewrite `resolveStoragePath()` to `path.resolve()` + assert containment, throwing `FileError("STORAGE_PATH_ESCAPE")` otherwise | R2, R3      | done   |

---

## Phase 3 — Regression coverage & verification

**Goal:** Prove the fix blocks the reported attack and doesn't regress legitimate uploads.
**Gate:** §R acceptance criteria met (typecheck + lint + full test suites green)

| task                                                                                                                                                                                                  | requirement | status |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T4: Add `apps/api/src/routes/files/files.test.ts` cases — traversal `moduleSlug` (`../../../../../../tmp/pwned`) and embedded separator (`hrms/../../etc`) both return 422, `saveUpload` never called | R4          | done   |
| T5: Add `packages/files/src/index.test.ts` cases — `resolveStoragePath` accepts well-formed keys, throws `FileError("STORAGE_PATH_ESCAPE")` for traversal keys                                        | R4          | done   |
| T6: `pnpm turbo run typecheck --filter=@platform/files --filter=@platform/api` clean                                                                                                                  | R4          | done   |
| T7: `npx eslint` on changed files clean (repo `pnpm lint` is a no-op per issue #141)                                                                                                                  | R4          | done   |
| T8: Full test suites green — `@platform/files` (20/20), `@platform/api` files route (18/18)                                                                                                           | R4          | done   |

---

## Kick-Off Prompt

All tasks above are already implemented and verified (see commit diff on branch `tushar`).
This plan is being frozen retroactively to satisfy the repo's plan-lock gate ahead of
`/review` + `/security-review`, per `.claude/rules/agent-behaviour.md`'s delivery flow —
no further coding is expected under this plan; the next step is review, not implementation.
