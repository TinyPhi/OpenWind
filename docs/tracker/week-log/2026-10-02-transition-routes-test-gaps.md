# 2026-10-02 — transition-route test gaps closed (#734, #735, #736)

**Session type:** Test hardening (non-blocking PR #733 review follow-ups)
**Branch:** `test/734-transition-routes-test-gaps`

All three changes are in `apps/api/src/routes/entities/transition-routes.test.ts`, and none
changes runtime behaviour.

- #734: `POST /:id/transitions` now covers `TRANSITION_LOCKED` → 409 with `Retry-After: 5`,
  matching `handle-workflow-error.ts`. It is a standalone test rather than an `it.each` row,
  because the table can't assert the header.
- #735: `GET /:id/transitions` gets the same cross-tenant test as the history endpoint. A caller
  from `OTHER_TENANT` gets a 404, `getAvailableTransitions` is never called, and every
  `withTenantContext` call uses the caller's tenant.
- #736: `TENANT` and `OTHER_TENANT` are UUID-format literals (`aaaaaaaa-0733-…`,
  `bbbbbbbb-0733-…`), in line with the rest of the repo.
- File: 28/28 passing (was 26).
