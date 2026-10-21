# 2026-10-20 — Make production runtime mode explicit

**Issue:** #1018

## Problem

`NODE_ENV` defaults to `development`. The supported production Compose override sets it to
`production`, but another orchestrator or a direct launch can omit it and silently disable
production-only safety checks. The hardening guide did not explain or verify this contract, while
the setup guide still directed production users to the development `setup.sh` and base Compose.

## Decision

- Keep the development default and label it next to `.env.example`'s assignment.
- Document that only exact `NODE_ENV=production` activates production safety checks.
- Show the required production Compose override and API/worker verification commands.
- Replace the stale production setup procedure with the authoritative OpenBao runbook link.

A reachability-based startup guard is not reliable: the API binds broadly inside safe Compose use
as well as potentially exposed direct deployments, while actual exposure is controlled outside the
process.

## Trade-off and residual exposure

The docs-only fix preserves convenient development behavior and avoids false startup failures, but
a bespoke launcher can still ignore the contract. Eliminating that risk requires an explicit
deployment mode or production entrypoint, outside #1018.

This is not stateful; it changes operator guidance only.

## Verification

- Red: the documentation check failed five requirements on unchanged main: runtime-mode guidance,
  non-Compose guidance, API and worker verification commands, and removal of the stale `setup.sh`
  production claim.
- Green: the same check exits 0 after the edits (`0 check(s) failed`).
- Prettier passes for every touched Markdown file; `.env.example` was inspected manually because
  the repository's Prettier configuration does not include environment files.
