# 2026-09-30 — undici and brace-expansion pins raised

**Session type:** Dependency fix (CI security scan failing on `main`)
**Branch:** `fix/deps-undici-brace-expansion`

- Four high advisories were published after #710 merged. The "Audit dependencies" step
  (`pnpm audit --audit-level=high`) failed on `main` at `1047f03`. Both packages are dev-only.
  - `undici` (admin-ui tests, via `jsdom`): GHSA-rfgv-xxqx-mfg5 (WebSocket subprotocol DoS) and
    GHSA-w293-vg96-wgc3 (BalancedPool TLS validation bypass). Patched in 7.29.1.
  - `brace-expansion` (ESLint tooling, via `@typescript-eslint`): GHSA-6j4f-fj2g-mc7p and
    GHSA-qhr7-859c-m2p7 (stack exhaustion). Patched in 5.0.10 / 5.0.11.
- The existing overrides in `pnpm-workspace.yaml` are raised to `>=7.29.1 <8` (still below 8 for
  jsdom) and `>=5.0.11`, with the advisories recorded inline. The lockfile resolves 7.30.0 and
  5.0.12.
- Verified:
  - `pnpm audit --audit-level=high`: 0 high (6 moderate, below the CI threshold);
  - `pnpm lint`: 49/49;
  - admin-ui: 47/48 files pass. The 9 failures are all in `reporting.test.tsx`, which fails
    locally on `main` too and passes in CI.
