# 2026-10-20 — #1033: CI builds the api and worker runtime images

- New CI job `runtime-images` builds the `runtime` target of both images (#1016) and checks each one: runs as
  uid 1000, has a HEALTHCHECK, contains `/app/dist/index.js`, `pnpm-workspace.yaml` and `modules/`, can write
  `/data/files`, and cannot write `/app/dist`. It does not start the apps (they need Postgres and OpenBao).
- Runs on pushes to main and on PRs that touch a Dockerfile, the lockfile, the workspace files, `turbo.json`,
  any `package.json`, or `ci.yml` (new `images` path filter). Added to the `ci-complete` gate.
- The check script was run against a real api image build locally, including a negative case; the first draft
  of the read-only check would have passed for an image that cannot run, so it uses `test ! -w` instead.
- Owner approved this edit to `.github/workflows` (agents may not change workflows on their own).
