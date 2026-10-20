# 2026-10-20 — #952 remaining item: ensureUserRefsKnown outside the entity transaction

- Audit of #952 against `main`: items 1 (pagination), 3 (`mentions` max 50), 4 (worker concurrency 5, 429
  fallback) and 5 (CHANGELOG) were already delivered by #955 and follow-ups; not re-done here.
- `ensureUserRefsKnown` no longer takes a transaction. It reads the `user_ref` field names and tenant
  membership in short tenant contexts, calls Zitadel with none open, then upserts in a second one
  (via `resolveTenantMembers`). `POST /entities` and `PATCH /entities/:id` call it before opening the
  entity transaction (the update route's entity-type lookup is its own short context).
- Behaviour note: the `tenant_users` upsert now commits even if the later create/update fails. Rows are only
  ever written for genuine org members, so this is harmless.
- Tests: Zitadel is asserted to run at tenant-context depth 0 in the lib and in both route tests.
- `/security-review` pending (run by the orchestrator).
