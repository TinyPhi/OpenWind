# 2026-10-20 — #637: PATCH route to change tenant retention after provisioning

- `PATCH /admin/tenants/:id/retention`: superadmin and platform operator only (fence runs before
  validation, so a non-operator gets 404 either way), live token introspection like the other
  mutating tenant routes. Fields `retention_days`, `retention_comment_days`,
  `retention_evidence_days`, `retention_hold`; at least one required, `null` clears.
- One Zod schema (`RetentionFieldsSchema` / `RetentionPatchSchema`, `packages/config/src/retention.ts`)
  now backs provisioning, the PATCH and the worker's `retention-policy.ts`. Provisioning no longer
  accepts a `retention_days` the sweep would ignore.
- Configurable: `RETENTION_DAYS_MIN/MAX`, `RETENTION_COMMENT_DAYS_MIN/MAX`,
  `RETENTION_EVIDENCE_DAYS_MIN/MAX` (defaults are the sweep's existing per-field bounds) and
  `RETENTION_REQUIRE_SHORTEN_CONFIRM` (default true). Env refines reject min above max and a default
  outside its bounds.
- Shortening below the current effective value needs `confirmShorten: true`, else 422
  `CONFIRM_SHORTEN_REQUIRED`. Merge uses `jsonb_set` / key removal so `rate_limit_per_min` survives.
- Audit: existing `updated` action on resource type `tenant`, same transaction, before and after of
  the changed keys. No migration.
- Confirmed: the sweep selects `tenants.config` for all tenants at the start of every run, no cache.
- `/security-review` still pending (run by the orchestrator).
