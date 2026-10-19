# 2026-10-16 — OpenBao decoupling guard and openbao-deploy (#974)

**Session type:** Bug fix
**Branch:** `fix/PLAT-hardening-openbao-guard-allowlist`
**Issue:** #974 (the guard has failed on `main` since #939)

- **Done.** `decoupling.architecture.test.ts` now allows `packages/openbao-deploy/` (OpenBao-specific deploy
  tooling: the container entrypoint loaders and the production compose check) next to `packages/secrets` and
  `packages/config`. A new assertion fails if any other workspace package lists `@platform/openbao-deploy` as a
  dependency, so the exemption stays deploy-only.
- **Why.** #939 added `check-prod-compose.ts`, which names `OPENBAO_*` six times. CI runs turbo-affected packages only,
  and `@platform/api` does not depend on `openbao-deploy`, so the api tests never reran and `main` went red unnoticed.
  The next PR to touch `packages/db` (#972) made api affected and surfaced it.
- **Verified.** The guard failed on a clean `main` before the change and passes after (3 of 3). Mutations: a package
  depending on `openbao-deploy` fails the new assertion; an `OPENBAO_` mention under a sibling directory named
  `openbao-deploy-evil` still fails the original one (the exemption matches `packages/openbao-deploy/` exactly).
- **Deferred.** The CI gap itself: a test that scans files across packages is not rerun when only a scanned package
  changes. Making turbo see those files as inputs of the api test (or running this test unconditionally) is a CI
  change, left open in #974.
