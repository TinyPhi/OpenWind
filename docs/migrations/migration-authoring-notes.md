# Migration Authoring Notes

Operational gotchas and conventions for authors writing new Drizzle
migrations under `packages/db/migrations/`.

---

## Immutability of applied migrations

**Never edit the SQL content of a migration file that has already been
applied to any environment** (staging, production, or a seeded dev DB).

Drizzle's migrator records a SHA-256 hash of each file in the
`__drizzle_migrations` table at apply time. On the next `pnpm db:migrate`
run it re-hashes the file on disk and compares against the stored hash; a
mismatch causes the migrator to abort with a checksum error. Even a
comment-only change breaks the hash.

If you need to clarify an old migration's intent, put the explanation in
this document or in a new migration's header comment — not in the old file.

---

## Pooled-connection safety: `::UUID` casts on GUC values (issue #554)

### The problem

Early migrations (0001 through ~0057) use this pattern in every RLS policy:

```sql
tenant_id = current_setting('app.tenant_id', true)::UUID
```

This is **latently dangerous on pooled connections.** Here is why:

1. The API sets the GUC with `SET LOCAL app.tenant_id = '<uuid>'` inside a
   transaction.
2. When the transaction commits, pgBouncer / Supavisor resets session-local
   GUCs on the physical connection before returning it to the pool.
3. The next request that reuses the same physical connection sees
   `current_setting('app.tenant_id', true)` return `''` (empty string).
4. `''::uuid` is not a valid UUID and Postgres raises:
   `invalid input syntax for type uuid: ""`
   This breaks the RLS policy evaluation for that request entirely.

### The safe form (use this in all new migrations)

```sql
tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
```

`nullif(..., '')` returns `NULL` when the GUC is empty. The `= NULL`
comparison in the RLS `USING` clause evaluates to `NULL` (not `TRUE`),
which causes Postgres to deny access to the row — the correct
fail-safe behaviour rather than a thrown exception.

This was introduced as the canonical pattern in migration
`0090_api_keys_rls_null_safe_tenant_guc.sql`, which also back-fills
the affected policies on the `api_keys` table. The RLS policies on
older tables (entity_instances, entity_relations, etc.) still use the
bare cast; they are covered in production by the connection-pool
configuration that sets the GUC reliably, but new policies must use
the `nullif`-wrapped form.

### Rule

> **Do NOT copy the bare `::UUID` cast** from migrations 0001–0057 into
> new migration files. Always use the `nullif`-wrapped form shown above.

---

## Commit message convention

Migration commits use `chore(db):` or `feat(db):` depending on whether
the migration adds net-new schema or only modifies/fixes existing schema.
Examples:

```
feat(db): add idempotency_keys table (0082)
chore(db): back-fill null-safe GUC cast on api_keys RLS (0090)
```
