# 2026-10-16 — OpenBao decoupling guard vs `packages/openbao-deploy` (CI fix on #947)

**Session type:** CI failure on #947 after upstream `main` was merged in
**Branch:** `feat/platform-admin-mfa-per-login`

- **Symptom.** #947's Tests job failed on one architecture test, "enforces that secrets
  storage remains decoupled from OpenBao", flagging
  `packages/openbao-deploy/src/check-prod-compose.ts`. #947's own code wasn't involved.
- **Cause.** #939 (production compose override with OpenBao secrets) added that deployment
  check, which reads `OPENBAO_*` settings. The guard's allowlist holds only
  `packages/secrets` and `packages/config`, although its header already allows bootstrap
  tooling. Upstream `main` therefore fails this test, and every PR that merges `main`
  inherits it.
- **Fix.** The guard also allows `packages/openbao-deploy/`. It still flags any other
  package that reads `OPENBAO_*` or calls `openbaoRequest`; checked with a throwaway probe
  file in `packages/teams`.
- **Follow-up.** The same one-line fix belongs on `main` itself (a small PR, or a heads-up
  to #939's author), so other open PRs stop failing on it.
