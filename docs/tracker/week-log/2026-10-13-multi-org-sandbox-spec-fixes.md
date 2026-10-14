# 2026-10-13 — multi-org-sandbox spec follow-ups (#802, #826)

**Session type:** Docs
**Branch:** `docs/PLAT-802-multi-org-sandbox-spec-fixes`

- #826: the two stale `GET /platform-admin/sandboxes/:tenantId/handover` references in `docs/specs/multi-org-sandbox.md` (the route list and R-text, lines 43 and 147) now say `:jobId`, matching the real route in `apps/api/src/routes/platform-admin/index.ts` since #805. The reset, delete and single-read routes still correctly use `:tenantId`.
- #802: T5 (Zitadel password-policy spike) is marked `deferred` and non-blocking instead of `open` under a header that said "implemented". Provisioning does not depend on it: `generateSandboxPassword` is generous on every character class and `isConflictResponse` accepts both the REST 409 and Zitadel's gRPC-gateway error shape. What is left is verifying both against a live Zitadel instance. The Phase 1 header now says "implemented, except T5".
- Not in this change: ADR-022 itself (#800, #801), which a human edits.
