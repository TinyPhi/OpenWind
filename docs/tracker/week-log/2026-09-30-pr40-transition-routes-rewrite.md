# 2026-09-30 — transition route tests rewritten (PR #40 provenance)

**Session type:** Contribution provenance (tests + two message strings)
**Branch:** `chore/PLAT-38-rewrite-transition-routes`

- PR #40 (the workflow transition routes, #38) came from an external contributor who never signed
  the CLA and can't be asked to. Their surviving lines were mostly in three route test files, at
  about 30% of each.
- Replaced `execute-transition.test.ts`, `list-transitions.test.ts` and
  `list-workflow-events.test.ts` with one new `transition-routes.test.ts` (26 tests). It was
  written from the handlers without reading the old files. It covers every old case, and adds 401
  and 403 role checks, `?roles=` narrowing, and 400s for bad idempotency keys.
- The cross-tenant history case asserts 404: RLS hides another tenant's record, so `getEntity`
  fails before the event log is read. #40's description said 200 with an empty list, which the
  access gate added later made out of date.
- `handle-workflow-error.ts`: the `TRANSITION_FORBIDDEN` and `REQUIRED_FIELDS_MISSING` messages now
  use the same wording as `error-handler.ts`. Status and error codes are unchanged. Reworded the
  route-order comment in `routes/entities/index.ts`.
- About 22 lines of framework boilerplate from #40 remain (imports, the `factory.createHandlers`
  pattern, braces). Rewriting them would give identical code.
