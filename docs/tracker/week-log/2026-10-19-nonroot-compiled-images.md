# 2026-10-19 — API and worker images: compiled, non-root, health-checked (#1016, launch R5)

**Session type:** Implementation
**Branch:** `chore/PLAT-1016-nonroot-compiled-images`
**Issues:** #1016

- **Done.**
  - Both Dockerfiles are multi-stage on `node:22-slim`: `build` (install, turbo build), `dev`
    (tsx as root, what the base compose uses), `deploy` (`pnpm deploy --legacy --prod`) and
    `runtime` (default; `node dist/index.js` as uid 1000, `HEALTHCHECK`). `--legacy` is needed
    because the workspace does not set `inject-workspace-packages`.
  - `docker-compose.prod.yml` uses `build.target: runtime` and `node dist/index.js`; the base
    `docker-compose.yml` uses `target: dev`.
  - Health: API `/health`; worker `/healthz` (already existed on port 3002, no new signal).
  - `drizzle-orm` moved from devDependencies to dependencies in `apps/api`: the API imports it
    at runtime and the production-only install otherwise omitted it. Lockfile updated.
  - `docs/deployment-hardening.md`: new section on the images and host ownership of the files
    directory (`chown 1000:1000`), plus a go-live checklist item.
- **Verified.** Built both targets of both images; smoke-ran `runtime` images on a throwaway
  network with throwaway Postgres/Redis: `id -u` = 1000, `docker ps` shows `healthy`, a fresh
  named volume at `/data/files` is writable, `/app/dist` is not, seed SQL under `/app/modules`
  is found, and the OpenBao loader at its compose path starts. The `dev` target runs as root and
  is healthy. Throwaway containers, network, volume and images were removed.
- **Not done.** Not run end to end with the production compose and a real OpenBao (needs the
  production secrets setup); the smoke used `SECRETS_PROVIDER=local`. No CI changes; the image
  build is not covered by a CI job.
