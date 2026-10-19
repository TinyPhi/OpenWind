# 2026-10-19 — Run the cross-package architecture guard on every PR (#974)

- **Done.** New CI step "Cross-package architecture guards" in the lint/typecheck job runs
  `decoupling.architecture.test.ts` unconditionally. It scans `apps/api/src`, `apps/worker/src` and
  `packages`, so the turbo affected filter (which only selects `@platform/api` when it or a dependency
  changes) let a change confined to `packages/openbao-deploy` skip it. The test itself was fixed in #977.
- **Not done.** Other cross-package scanning tests, if added, need the same treatment.
