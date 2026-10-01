# 2026-10-01 — @grpc/grpc-js pin added

**Session type:** Dependency fix (CI security scan failing on `main` and every open PR)
**Branch:** `fix/deps-grpc-js-pin`

- A high advisory was published after #720 merged. The "Audit dependencies" step
  (`pnpm audit --audit-level=high`) failed on `main` and on every PR branch (e.g. run 36826831865).
  - `@grpc/grpc-js` 1.14.4 (via `packages/telemetry`'s OTel gRPC exporters, 8 paths):
    GHSA-m9gg-hp2v-232j (`getAuthContext` can report unauthorized client certificates as
    authorized). Patched in 1.14.5.
- New override in `pnpm-workspace.yaml`: `"@grpc/grpc-js": ">=1.14.5 <2"` (stays on the 1.x line
  the exporters declare), advisory recorded inline. The lockfile resolves 1.14.5; no other
  package moves.
- Dependabot security updates enabled on the repo (repo setting, no file change) so future
  advisories arrive as bump PRs.
- Follow-up for a human (workflow files are off-limits to agents): split the audit into its own
  CI job that blocks on push/schedule/dependency-touching PRs but only warns on other PRs, so an
  advisory published after a branch was cut stops failing every open PR at once.
- Verified:
  - `pnpm audit --audit-level=high`: 0 high (7 moderate, below the CI threshold);
  - `pnpm typecheck` 51/51, `pnpm lint` 51/51;
  - `pnpm test` / `pnpm test:isolation`: all pass except `@platform/worker`'s 10 DB-backed
    isolation files, which fail locally with `password authentication failed for user "platform"`
    (local test-DB credential drift, unrelated to this diff).
