# 2026-10-13 — GDPR: tenant purge scrubs audit JSON (#860)

**Session type:** Code
**Branch:** `fix/PLAT-860-audit-json-anonymization`

- Decision taken (owner call on #860, option (a)), with a refinement: scrub **by value, not by path**. A path registry over 83 audit write sites and 38+ actions would drift; instead every string value or object key in `metadata`, `before_snapshot` and `after_snapshot` that equals a person identifier is replaced with `[REDACTED]`, at any depth. Spec: `docs/specs/audit-log-json-anonymization.md`.
- Identifier set: the tenant's `tenant_users` ids and emails plus the distinct user `actor_id` and `acting_person_id` values in its own audit rows (people who acted but left). Ids under 3 characters are ignored; emails match case-insensitively; display names are deliberately not matched (not unique). Out of scope: `resource_id` (a uuid), longer strings that merely contain an id, per-user erasure of the audit log (kept on purpose, Art. 17(3)(b)).
- Ordering fix: `tenant-purge.ts` deleted `tenant_users` and only then anonymized the audit log, so the member list was gone by then and a retry could not rebuild it. The anonymization now runs in the privileged pre-step, before the delete transaction. It is idempotent.
- The batch loop walks the tenant's rows by id (keyset) instead of "actor not yet anonymized", so it terminates and revisits rows whose actor columns were already scrubbed. Rows with nothing to scrub are not written.
- Tests: pure unit tests for the walk; a real-Postgres purge test that runs the actual processor with a member who never acted (their id exists only in `tenant_users`), nested/array/key ids, emails, a former member, short ids, a bystander tenant and an idempotent re-run.
- Note for local runs: the worker resolves `@platform/audit` through its built `dist/`, so rebuild it (`pnpm --filter @platform/audit build`, or run `pnpm test`, which builds first) before running a single worker isolation file.
- Security-reviewer pass: no blocking findings. Taken: a literal `__proto__` key is kept (built with `Object.fromEntries`), a real key named like the placeholder can't collide with a redacted one, and a document deeper than 64 levels is replaced whole instead of recursing (a `RangeError` would fail every retry). Accepted and written into spec D7: exact-match limits, the common-word edge, and a narrow late-row window.
