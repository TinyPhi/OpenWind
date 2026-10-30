## 2026-10-31 — #1142 Superset production config

### Done

- `docker-compose.prod.yml`: `ow-worker` now requires `SUPERSET_SERVICE_ACCOUNT_PASSWORD` in
  `BAO_REQUIRED_KEYS` and gets `SUPERSET_INTERNAL_URL` and `SUPERSET_SERVICE_ACCOUNT_USER`, as
  `ow-backend` has. `ALLOWED_ENV` in `check-prod-compose.ts` updated to match, with a test that the
  password is required at backend, worker and superset-init and the OAuth client id never is.
- `SUPERSET_OAUTH_CLIENT_ID` stays out of every `BAO_REQUIRED_KEYS` on purpose: it turns Stage 2 on.
- Runbooks: `superset-erasure.md` production setup is now a four-service checklist with an upgrade
  note (add the worker key before deploying); `openbao-secrets.md` checklist updated;
  `setup-superset-oauth.ts` prints the checklist.
- Security review triage: the fail-open when only some services have the client id is not fixed here.
  A guard is a design change tracked in #1137; this PR documents the gap. The upgrade-ordering risk
  was accepted and documented (runbook and CHANGELOG).

### Verification

- See the PR description for the command results.

### Next

- #1137: guard so backend and worker cannot run cache-only while Superset has Stage 2 on.
