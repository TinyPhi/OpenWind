# 2026-10-02 — export endpoint rate limit and download audit (#692, #693)

**Session type:** Security hardening (follow-ups from the PR #687 review)
**Branch:** `fix/692-693-export-hardening`

- #692: `GET /entity-types/:id/export` is now limited per (tenant, user):
  `RATE_LIMIT_EXPORT_PER_MIN`, default 5 per 60s. The limit uses the new `enforceExportRateLimit`
  in `rate-limit-tiers.ts`. It runs after `requireAuth` and before any DB read. Over the limit
  it returns 429 with `Retry-After`, and it fails open on Redis errors like the other tiers.
- #693: `GET /exports/:jobId/download` writes `export.downloaded` before handing out the
  presigned URL, and refuses the URL if that write fails. A same-tenant PII refusal writes
  `export.download_denied`. Cross-tenant and missing jobs stay unaudited 404s.
- Migration `0131` adds both actions to `audit_log_action_check`. `AuditAction`, `outcome.ts`
  and `request-kind.ts` change in the same commit.
- Tests: route unit tests (download +8, export +3, tier +4), `packages/audit` action tests, and
  a new `export-download-audit.isolation.test.ts` (real Postgres, RLS read as the other tenant).
- Spec: `docs/specs/export-audit-trail.md` §X.
