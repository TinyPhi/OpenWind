# ADR-001: Multi-tenancy Architecture

**Status:** Accepted  
**Date:** 2025-05  
**Deciders:** Engineering lead, Platform architect  
**Supersedes:** —  
**Superseded by:** —

---

## Context

The platform serves multiple independent businesses (tenants). Each tenant's data must be completely isolated from every other tenant — a user of Tenant A must never be able to access, infer, or accidentally receive data belonging to Tenant B. This is not a feature; it is a safety and compliance invariant that must hold under all conditions including developer error, misconfigured queries, and application bugs.

Beyond isolation, the tenancy model governs:

- How schema migrations are applied across the customer base
- How connection pooling and query routing work
- How background jobs are scoped and rate-limited
- How file storage is partitioned
- How operational monitoring is structured
- The cost of adding new customers

We evaluated three models: **database-per-tenant**, **schema-per-tenant**, and **shared schema with Row-Level Security (RLS)**. The decision has long-term consequences that are expensive to reverse.

### Scale assumptions

At initial launch: 10–50 tenants. Year 2 target: 200–500 tenants. Year 3+: potentially thousands, including smaller SMB customers on lower-tier plans. The tenancy model must not become an operational bottleneck at any of these scales.

### Team assumptions

The team is primarily TypeScript engineers. Deep Postgres expertise is present but not uniformly distributed. The tenancy model must be safe for a developer who is not a Postgres expert — it should be difficult to make the wrong choice by accident.

---

## Evaluated Options

### Option 1: Database-per-tenant

Each customer gets a dedicated Postgres database. Tenant A's data lives in `db_tenant_a`, Tenant B's in `db_tenant_b`, and so on.

**How it works:** The application maintains a connection string registry keyed by tenant ID. On each request, it looks up the tenant's connection string and uses that pool for all queries. No shared state between databases.

**Advantages:**

- Maximum isolation. A query cannot accidentally cross tenant boundaries.
- Independent backup and restore per tenant.
- Possible to offer dedicated hardware tiers to large customers.
- Schema migrations can be applied per-tenant on independent schedules.
- A runaway query or lock on one tenant cannot affect others.

**Disadvantages:**

- Connection pool explosion. Postgres allows roughly 100–200 active connections per database safely. With 500 tenants, each needing a minimum pool of 5 connections, that is 2,500 connections and 500 independent Postgres processes. This is a significant infrastructure cost and operational burden.
- Migration complexity scales with tenant count. Applying a schema change to 500 databases means 500 sequential (or parallelized but complex) migration operations. A failed migration on tenant 237 leaves the fleet in a partially-migrated state. The tooling to manage this safely is non-trivial.
- Cross-tenant analytics are expensive. Generating platform-wide reports (e.g., total tickets across all customers) requires federated queries across hundreds of databases.
- No feasible path to the SMB tier. A business with 5 employees cannot justify the overhead of their own database, and the platform cannot afford it either.

**Verdict:** Rejected. Operationally untenable beyond ~20 customers.

---

### Option 2: Schema-per-tenant

All tenants share a single Postgres instance, but each tenant has a dedicated Postgres schema (namespace). Tenant A's tables are in the `tenant_a` schema, Tenant B's in `tenant_b`. The `search_path` on each connection is set to the tenant's schema.

**How it works:** On each request, the application sets `SET search_path TO tenant_abc, public` so all unqualified table references resolve to that tenant's schema. Every schema has identical table definitions.

**Advantages:**

- Better resource sharing than database-per-tenant. One Postgres process, one connection pool per application instance (via PgBouncer with schema-level routing).
- Still good isolation — unqualified queries can only see the current schema.
- Per-tenant backup is possible via `pg_dump --schema=tenant_abc`.

**Disadvantages:**

- DDL migrations still scale linearly. Adding a column to `entity_instances` means running `ALTER TABLE` on 500 schemas. With Postgres DDL taking `AccessExclusiveLock`, this blocks reads and writes on each schema during the migration window. Even parallelized, this is slow and risky.
- Postgres schema count limit. While Postgres technically supports thousands of schemas, the `pg_catalog` overhead grows with schema count. `VACUUM`, `ANALYZE`, and `pg_dump` slow down as schema count increases. This is a well-documented production issue at >1,000 schemas.
- `search_path` manipulation is fragile. A missing middleware, a connection reuse bug, or a transaction that doesn't reset `search_path` can silently query the wrong schema. This class of bug is subtle and hard to detect in testing.
- Cross-tenant queries require dynamic SQL with explicit schema names, which is messy and error-prone.

**Verdict:** Rejected. Migration scaling and `search_path` fragility are unacceptable risks.

---

### Option 3: Shared schema with Row-Level Security (RLS) ✅ Selected

All tenants share the same Postgres schemas and tables. Every tenant-scoped row has a `tenant_id` column. Postgres Row-Level Security policies enforce that a database session can only access rows matching its declared `tenant_id`. The application sets a session-level variable at the start of each request, and all subsequent queries in that session are automatically filtered.

**How it works:**

```sql
-- On every tenant-scoped table:
ALTER TABLE entity_instances ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON entity_instances
  USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- Application middleware sets this at request start:
SET LOCAL app.tenant_id = 'abc-123-...';
```

All queries against `entity_instances` in that session automatically get `WHERE tenant_id = 'abc-123-...'` appended by the database engine, invisibly, before execution. There is no way to forget this — it is enforced at the storage layer, not the application layer.

**Advantages:**

- Isolation is enforced by Postgres, not application code. A developer who writes `SELECT * FROM entity_instances` without a WHERE clause gets only their tenant's rows, not all rows. This is the critical safety property.
- One schema definition. DDL migrations run once and apply to all tenants instantly. Adding a column is a single `ALTER TABLE` statement, regardless of tenant count.
- Operational simplicity scales. Connection pooling, monitoring, vacuuming, and backup all operate on a single database. Adding the 500th customer adds rows, not infrastructure.
- Cross-tenant analytics are possible (for platform operators using a superuser connection that bypasses RLS).
- This is the production-proven model used by Supabase, PostgREST, Neon, and numerous multi-tenant SaaS applications.

**Disadvantages and mitigations:**

- **RLS performance overhead.** RLS policies add a predicate to every query. This is mitigated by: (a) indexing `tenant_id` on every table, (b) composite indexes that include `tenant_id` as the leading column for frequently-filtered queries, (c) benchmarking confirms the overhead is <3% for indexed queries at our scale.
- **Superuser bypass.** A session connected as a Postgres superuser bypasses RLS. Mitigation: the application's database user is never a superuser. Migration tooling uses a separate user with `BYPASSRLS` only during migration runs, not during normal operation.
- **Large tenant row counts.** A single extremely large tenant could degrade query performance for other tenants if their queries generate large sequential scans. Mitigation: per-tenant query timeouts, per-tenant connection limits via PgBouncer, and read replicas for analytics workloads.
- **Complexity of initial setup.** Getting RLS policies right requires careful testing. Mitigation: the tenant isolation test suite (described below) runs against every PR.

---

## Decision

**We adopt shared schema with Postgres Row-Level Security.**

### Implementation specification

#### 1. Session variable middleware

Every database connection used for application requests must have the tenant context set before any query executes.

```typescript
// packages/db/src/middleware.ts
import { sql } from "drizzle-orm";
import { db } from "./client";

export async function withTenantContext<T>(
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
      //                                              ^^^^ true = local to transaction
    );
    return fn();
  });
}
```

The `true` parameter to `set_config` makes the setting local to the current transaction, ensuring it is reset when the transaction ends and cannot leak to a pooled connection.

#### 2. RLS policy template

All tenant-scoped tables must follow this pattern exactly:

```sql
-- Required on every tenant-scoped table, no exceptions
ALTER TABLE {table_name} ENABLE ROW LEVEL SECURITY;

-- Read policy
CREATE POLICY tenant_read ON {table_name}
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Write policy (INSERT/UPDATE/DELETE)
CREATE POLICY tenant_write ON {table_name}
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

The `true` argument to `current_setting` makes it return `NULL` rather than throwing an error if the variable is not set. A query executed without a tenant context set will match no rows (since `NULL = uuid` is false), failing safely rather than returning all rows.

#### 3. Database user permissions

Three database users are provisioned:

| User             | Permissions                           | Used by                               |
| ---------------- | ------------------------------------- | ------------------------------------- |
| `app_user`       | DML on all tables, subject to RLS     | API server, workers                   |
| `migration_user` | DDL + BYPASSRLS                       | Migration tool only, never in runtime |
| `analytics_user` | SELECT + BYPASSRLS on specific tables | Metabase, internal reporting          |

The `app_user` cannot alter schemas, cannot `BYPASSRLS`, and cannot access `pg_catalog` beyond what is needed for connection. Connection strings for `migration_user` and `analytics_user` are never present in application environment variables — only in migration and analytics tooling respectively.

#### 4. Index requirements

Every tenant-scoped table must have:

```sql
-- Standalone tenant index (supports EXISTS checks and deletion)
CREATE INDEX ON {table} (tenant_id);

-- Composite index for the most common query pattern
-- (tenant + the most frequently filtered column)
CREATE INDEX ON entity_instances (tenant_id, entity_type_id);
CREATE INDEX ON entity_instances (tenant_id, current_state);
CREATE INDEX ON workflow_events (tenant_id, instance_id);
CREATE INDEX ON automation_executions (tenant_id, rule_id, status);
```

The Drizzle schema definition is the source of truth for indexes. Any migration that adds a tenant-scoped table without a `tenant_id` index fails CI.

#### 5. Tenant isolation test suite

A dedicated test suite in `tests/isolation/` attempts to breach tenant isolation via every public API endpoint and every internal service call. The suite:

- Creates two test tenants (A and B) with populated data
- Makes every API call as Tenant A
- Asserts that no response contains any data belonging to Tenant B
- Attempts direct database queries without the tenant context set and asserts empty results
- Tests that INSERT without a matching tenant_id is rejected

This suite runs on every PR that touches any file in `packages/db/`, `apps/api/`, or any module's routes. Failures block merge.

#### 6. Migrations

All schema migrations are in `packages/db/migrations/`. Migration files are numbered sequentially (`0001_initial.sql`, `0002_add_workflow_events.sql`). Every migration is:

- Written in plain SQL (not Drizzle's push API) so it can be reviewed, tested, and rolled back explicitly
- Run in a transaction so a partial migration failure leaves no half-applied state
- Tested in CI against a fresh database before being approved
- Applied to production during a deployment window by the `migration_user`

New tenant-scoped tables must include RLS setup in the same migration file. The migration reviewer checklist includes:

- [ ] Does the table have `tenant_id uuid NOT NULL`?
- [ ] Is `ENABLE ROW LEVEL SECURITY` present?
- [ ] Are both read and write policies defined?
- [ ] Is a `tenant_id` index present?
- [ ] Has the isolation test suite been updated to cover the new table?

#### 7. Non-tenant-scoped tables

Some tables are legitimately platform-wide and should not be tenant-scoped: `tenants`, `modules`, `entity_types` (for platform-defined types), `workflow_templates`, `connector_definitions`. These tables have RLS disabled and are readable by `app_user` but writable only by `migration_user` or specific admin-role endpoints.

#### 8. Per-tenant limits via PgBouncer

PgBouncer is configured with per-database (per-application-user) connection limits. Application-level rate limiting enforces per-tenant query budgets. Large tenants generating disproportionate query load trigger alerts and are reviewed for dedicated read-replica routing.

---

## Consequences

### Positive

- Tenant isolation is enforced at the database layer. Application developers cannot accidentally bypass it.
- Schema migrations are a single operation regardless of tenant count. Scaling from 10 to 10,000 customers does not change migration complexity.
- Operational simplicity: one database, one connection pool, one backup, one monitoring target.
- The model is well-understood and production-proven. Documentation, troubleshooting guides, and expertise are widely available.

### Negative

- Every developer must understand RLS. A developer who connects directly to the database (e.g., via `psql` for debugging) must remember to set `app.tenant_id` or they will see no rows. This is counterintuitive at first and requires documentation and team onboarding.
- Bulk operations across all tenants (e.g., a platform-wide backfill) require the `analytics_user` or a dedicated admin connection. This is an intentional constraint but requires awareness.
- A single large tenant's write volume can degrade performance for other tenants. This is mitigated by indexes, timeouts, and connection limits, but it is a real constraint that does not exist in the database-per-tenant model.

### Reversibility

Migrating away from shared schema + RLS to schema-per-tenant at a later date is possible but expensive (estimated 4–6 weeks of engineering work plus a migration window). This decision should be treated as essentially permanent. If the team has serious reservations, they should be raised now, not after the first migration is written.

---

## Open Questions

These questions were surfaced during architecture review and have not yet been resolved. They should be answered before the relevant phase ships.

| ID        | Question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Phase      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| **MT-01** | Still open (confirmed 2026-08-24): issue #5's tenant-deletion acceptance criteria propose a 30-day default, but that's an unmerged issue proposal, not accepted policy — no code enforces an erasure deadline, and issue #19 (3D observability/compliance) still lists a "verifiable erasure within SLA" flow as unshipped. No owning role/team is named anywhere. Genuinely needs a product/legal decision, not further code investigation.                                                                                                                                                                                   | Phase 2    |
| **MT-02** | **Resolved (2026-08-24):** Workers never trust `job.data.tenantId` for authorization. `withTenantContext` (`packages/db/src/middleware.ts`) switches to the RLS-enforced `app_user` role and sets `app.tenant_id` via `set_config` inside a transaction — Postgres RLS, not the job payload, is the actual trust boundary. `validateActiveTenant` (`apps/worker/src/tenant-guard.ts`) additionally rejects jobs for deactivated/missing tenants before any query runs. No cryptographic job-signing scheme exists or is planned — a malformed job can at most act as a syntactically-valid tenant, still fully bounded by RLS. | Phase 1 ✅ |
| **MT-03** | Still open (confirmed 2026-08-24): issue #196 explicitly closed this as "go investigate" rather than resolved — it names connection-pool ceiling and `ts_rank` pagination cliffs as needing "a concrete target (expected concurrent tenants/requests)" before any threshold decision. No row-count/tenant-count threshold has been defined anywhere. Needs real load-test data that doesn't exist yet.                                                                                                                                                                                                                         | Phase 3    |
| **MT-04** | Still open (confirmed 2026-08-24): `entityTypes` (`packages/db/src/schema/entity-engine.ts`) and `workflows` (`packages/db/src/schema/workflow-engine.ts`) have zero version columns between them — no `version`, `schemaVersion`, or migration-tracking field exists on either. There is no versioning concept for platform-wide entity types today; this is an unbuilt-feature gap, not something more code-reading will answer.                                                                                                                                                                                             | Phase 2    |
| **MT-05** | Still open (confirmed 2026-08-24): issue #5 gives `outbox_events` a concrete retention design (7-day TTL delivered, 72h dead-letter threshold) — that part is real. Grepping migrations/schema for `retention`/`pg_cron`/`dead_letter` tied to `workflow_events` or `automation_executions` returns nothing — no cron job, TTL, or archival path exists for either. Issue #19 lists "pg_cron jobs for outbox + workflow event archival" as still-unshipped Phase 3 scope. No change from the ADR's original state.                                                                                                             | Phase 2    |

---

## Addendum: Analytics Access Policy

**Added:** 2026-05-22 — closes issue #2 item 3  
**Migration:** `0009_analytics_user_grants.sql`

### Problem

`analytics_user` was granted `BYPASSRLS` to support cross-tenant reporting queries (Metabase, Phase 2D). The original ADR noted "specific tables" but did not enumerate them. The result was an undefined access scope — any new table was silently readable by `analytics_user` unless someone explicitly revoked it.

### Decision

**Explicit opt-in, default deny.** `analytics_user` has zero access to any table unless a migration explicitly grants it.

Migration `0009` implements this in three steps:

1. `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM analytics_user` — new tables are inaccessible by default at the database level, independent of application code or CI checks.
2. `REVOKE ALL ON ALL TABLES` — strips any grants added before this migration.
3. Per-table, per-column `GRANT SELECT` — only the columns listed are readable.

### Per-table access policy

| Table                                                    | analytics_user access                                                             | Reason                                            |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------- |
| `tenants`                                                | `id, name, slug, plan, status, created_at, updated_at`                            | No sensitive config                               |
| `entity_types`                                           | All columns                                                                       | No sensitive data                                 |
| `entity_fields`                                          | All columns incl. `sensitivity`                                                   | Sensitivity is metadata, not a secret             |
| `entity_instances`                                       | All columns **except `fields`**                                                   | `fields` JSONB may contain raw PII                |
| `entity_relations`                                       | All columns                                                                       | No sensitive data                                 |
| `workflows` / `workflow_states` / `workflow_transitions` | All columns                                                                       | Config only, no PII                               |
| `workflow_events`                                        | **Via `workflow_events_masked` view only**                                        | `metadata` JSONB may contain PII/financial values |
| `automation_rules`                                       | `id, tenant_id, name, is_enabled, trigger_type, priority, created_at, updated_at` | `actions` JSONB may contain webhook URLs/API keys |
| `automation_executions`                                  | All columns                                                                       | Result JSONB contains counts only                 |
| `outbox_events`                                          | **Excluded**                                                                      | Payload mirrors `entity_instances.fields`         |
| `dead_letter_events`                                     | **Excluded**                                                                      | Same as `outbox_events`                           |
| `api_keys`                                               | **Excluded**                                                                      | `key_hash` is a credential                        |
| `tenant_users`                                           | **Excluded**                                                                      | `user_id` is PII under GDPR                       |
| `connector_credentials`                                  | **Excluded**                                                                      | `credentials` is encrypted ciphertext             |

### `workflow_events_masked` view

`analytics_user` accesses `workflow_events` only via the `workflow_events_masked` view, which replaces values for fields with `sensitivity IN ('pii', 'financial')` with `"[REDACTED]"` at query time. This is a secondary safety net — the primary defence is application-layer redaction at INSERT time in `executeTransition`.

### Convention for future migrations

Every migration that creates a new table **must** include one of these annotations on a comment line:

```sql
-- analytics: excluded (reason why analytics_user must not access this table)
-- analytics: included(col1, col2, col3)
```

CI lint (implemented in migration `0009`) scans all migration files for new `CREATE TABLE` statements and fails if no `-- analytics:` annotation is present. PRs adding new tables without this annotation will not pass CI.

This convention is enforced at the CI level; the `ALTER DEFAULT PRIVILEGES` in migration `0009` is the database-level backstop.
