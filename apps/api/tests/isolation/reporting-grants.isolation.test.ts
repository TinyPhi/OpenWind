/**
 * Isolation tests for the reporting role's data surface.
 *
 * These exist because a whole class of reporting bug was invisible to every
 * check that came before them. The reporting path does not run as `app_user`
 * and is not exercised by any handler test: it is a second database role
 * (`analytics_user`) with its own grants, reading through its own connection,
 * scoped by GUCs that Superset's connection mutator stamps. Nothing in the
 * suite touched that role, so three separate PII exposures and one outage all
 * shipped past a green test run.
 *
 * Each test below maps to a defect that actually happened. See
 * docs/specs/reporting-metadata-masking-repair.md §B.
 *
 *   B2  migration 0113 granted `workflow_events` wholesale, restoring the raw
 *       `metadata` payload that 0112 had deliberately withheld
 *   B6  the same for `tenant_users`, which exposed user email addresses
 *   B7  the same for `entity_instances`, exposing the ticket form payload and
 *       the search vector derived from it
 *   B13 the repair for B7 broke 23 of 35 charts: Superset applies a guest
 *       token's row filter to a virtual dataset by rewriting the base table
 *       into `SELECT * FROM <table> WHERE …`, and a wildcard needs table-level
 *       SELECT, which column-level grants cannot satisfy
 *
 * The B13 test is the one to keep honest. It asserts the *shape* Superset
 * generates, not a hand-written column list — writing the columns out is
 * precisely what made every earlier check pass while the dashboard was broken.
 *
 * Runs against a real Postgres instance with a real second connection as
 * `analytics_user`. A mocked database cannot express any of this: the whole
 * subject is grants and row-level security.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql as dsql } from "drizzle-orm";
import postgres from "postgres";
import {
  db,
  tenants,
  entityTypes,
  entityInstances,
  workflows,
  workflowEvents,
} from "@platform/db";

const TENANT_A = "aaaaaaaa-0000-4000-a000-000000000117";
const TENANT_B = "bbbbbbbb-0000-4000-b000-000000000118";

const OWNER = "reporting-iso-owner";
const OTHER = "reporting-iso-other";

/**
 * The reporting credential, not the application one. The fallback reuses
 * DATABASE_URL's host and database, so the test reads the rows it seeded
 * rather than whatever another database holds; the password matches
 * docker/postgres/init.
 */
function analyticsUrl(): string {
  const explicit = process.env["ANALYTICS_DATABASE_URL"];
  if (explicit) return explicit;
  const url = new URL(process.env["DATABASE_URL"] ?? "");
  url.username = "analytics_user";
  url.password = "analytics_user_dev_password";
  return url.toString();
}
const ANALYTICS_URL = analyticsUrl();

let sql: postgres.Sql;
let entityTypeId: string;
let workflowAId: string;

/** Run one statement on the reporting connection with the GUCs Superset stamps. */
async function asAnalyst<T>(
  guc: { tenant?: string; scope?: string; userId?: string },
  run: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    // set_config(..., true) is transaction-local, which mirrors how the
    // connection mutator stamps a fresh connection per query.
    if (guc.tenant !== undefined) {
      await tx`SELECT set_config('app.tenant_id', ${guc.tenant}, true)`;
    }
    if (guc.scope !== undefined) {
      await tx`SELECT set_config('app.reporting_scope', ${guc.scope}, true)`;
    }
    if (guc.userId !== undefined) {
      await tx`SELECT set_config('app.reporting_user_id', ${guc.userId}, true)`;
    }
    return run(tx);
  }) as Promise<T>;
}

beforeAll(async () => {
  sql = postgres(ANALYTICS_URL, { max: 1, onnotice: () => {} });

  await db.insert(tenants).values([
    { id: TENANT_A, name: "Reporting Iso A", slug: `rep-iso-a-${Date.now()}` },
    { id: TENANT_B, name: "Reporting Iso B", slug: `rep-iso-b-${Date.now()}` },
  ]);

  const [etRow] = await db
    .insert(entityTypes)
    .values({
      tenantId: null,
      name: `reporting_iso_${Date.now()}`,
      plural: `reporting_isos_${Date.now()}`,
      allowCustomFields: true,
    })
    .returning();
  if (!etRow) throw new Error("entity type insert failed");
  entityTypeId = etRow.id;

  const [wfA] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT_A,
      entityTypeId,
      name: "Reporting Iso Workflow A",
      initialState: "open",
      createdBy: OWNER,
      assignedTo: [OWNER],
    })
    .returning();
  if (!wfA) throw new Error("workflow insert failed");
  workflowAId = wfA.id;

  // Two tickets in tenant A: one owned by OWNER, one by somebody else. The
  // own-rows test needs both to prove it narrows rather than returning all.
  const tickets = await db
    .insert(entityInstances)
    .values([
      {
        entityTypeId,
        tenantId: TENANT_A,
        workflowId: workflowAId,
        currentState: "open",
        fields: {
          title: "Reporting iso mine",
          department: "IT",
          priority: "high",
        },
        createdBy: OWNER,
        assignedTo: OWNER,
      },
      {
        entityTypeId,
        tenantId: TENANT_A,
        workflowId: workflowAId,
        currentState: "open",
        fields: {
          title: "Reporting iso theirs",
          department: "HR",
          priority: "low",
        },
        createdBy: OTHER,
        assignedTo: OTHER,
      },
    ])
    .returning({
      id: entityInstances.id,
      createdBy: entityInstances.createdBy,
    });

  // One event on each ticket, so the own-rows policy on workflow_events has
  // something to narrow: a non-staff session must see only the event on its
  // own ticket, even though both are in its tenant.
  await db.insert(workflowEvents).values(
    tickets.map((t) => ({
      tenantId: TENANT_A,
      instanceId: t.id,
      workflowId: workflowAId,
      fromState: null,
      toState: "open",
      triggeredBy: "user",
      actorId: t.createdBy,
      comment: `Reporting iso event for ${t.createdBy}`,
    })),
  );
});

afterAll(async () => {
  // Order matters: the entity type is global (tenantId null), so deleting the
  // tenants does not take its instances with it. Events go first: they
  // reference the instances.
  await db
    .delete(workflowEvents)
    .where(eq(workflowEvents.workflowId, workflowAId));
  await db
    .delete(entityInstances)
    .where(eq(entityInstances.entityTypeId, entityTypeId));
  await db.delete(workflows).where(eq(workflows.entityTypeId, entityTypeId));
  await db.delete(tenants).where(eq(tenants.id, TENANT_A));
  await db.delete(tenants).where(eq(tenants.id, TENANT_B));
  await db.delete(entityTypes).where(eq(entityTypes.id, entityTypeId));
  await sql.end({ timeout: 5 });
});

describe("reporting role cannot read PII payloads (migrations 0118/0120/0122)", () => {
  it("refuses the raw ticket form payload (B7)", async () => {
    await expect(
      asAnalyst(
        { tenant: TENANT_A },
        (tx) => tx`SELECT fields FROM entity_instances LIMIT 1`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses the search vector derived from that payload (B7)", async () => {
    // Granting this would re-expose the payload's contents one lexeme at a time.
    await expect(
      asAnalyst(
        { tenant: TENANT_A },
        (tx) => tx`SELECT search_vector FROM entity_instances LIMIT 1`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses the raw event payload (B2)", async () => {
    await expect(
      asAnalyst(
        { tenant: TENANT_A },
        (tx) => tx`SELECT metadata FROM workflow_events LIMIT 1`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses user email addresses (B6)", async () => {
    await expect(
      asAnalyst(
        { tenant: TENANT_A },
        (tx) => tx`SELECT email FROM tenant_users LIMIT 1`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses a wildcard on the base ticket table", async () => {
    // The column allowlist is only real if `*` cannot sidestep it.
    await expect(
      asAnalyst(
        { tenant: TENANT_A },
        (tx) => tx`SELECT * FROM entity_instances LIMIT 1`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("holds no table-level grant on any table carrying a payload", async () => {
    // A table-level grant is what silently re-opened all three exposures: it
    // covers every column, including ones added later that nobody reviewed.
    const rows = await asAnalyst(
      {},
      (tx) => tx`
      SELECT table_name FROM information_schema.table_privileges
       WHERE grantee = 'analytics_user'
         AND table_name IN ('entity_instances', 'workflow_events', 'tenant_users')
    `,
    );
    expect(rows.map((r) => r["table_name"])).toEqual([]);
  });

  it("still reads the columns reporting legitimately needs", async () => {
    const rows = await asAnalyst(
      { tenant: TENANT_A },
      (tx) => tx`
      SELECT reporting_title, reporting_department, reporting_priority, current_state
        FROM entity_instances WHERE deleted_at IS NULL
    `,
    );
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r["reporting_title"]).sort()).toEqual([
      "Reporting iso mine",
      "Reporting iso theirs",
    ]);
  });
});

describe("reporting_instances view keeps Superset's row-filter rewrite working (B13)", () => {
  it("permits the wildcard shape Superset actually generates", async () => {
    // Deliberately `SELECT *`, and deliberately wrapped as a filtered subquery
    // aliased back to `ei` — this is the shape Superset rewrites a virtual
    // dataset's base table into when a guest token carries a row filter. Every
    // pre-existing check named its columns, which is exactly why none of them
    // caught the outage this reproduces.
    const rows = await asAnalyst(
      { tenant: TENANT_A },
      (tx) => tx`
      SELECT count(*)::int AS n FROM (
        SELECT * FROM reporting_instances
         WHERE assigned_to = ${OWNER} OR created_by = ${OWNER}
      ) AS ei
    `,
    );
    expect(rows[0]?.["n"]).toBe(1);
  });

  it("exposes no payload column through the view", async () => {
    const cols = await asAnalyst(
      {},
      (tx) => tx`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'reporting_instances'
    `,
    );
    const names = cols.map((c) => c["column_name"]);
    expect(names).not.toContain("fields");
    expect(names).not.toContain("search_vector");
  });

  it("evaluates row-level security as the caller, not the view owner", async () => {
    // security_invoker must stay on. With it off the view runs as its owner,
    // who owns the base tables and holds BYPASSRLS, and tenant isolation
    // disappears with no error to announce it (migration 0112 measured this:
    // 0 rows direct, all 48 through the view).
    const [row] = await asAnalyst(
      {},
      (tx) => tx`
      SELECT reloptions::text AS opts FROM pg_class WHERE relname = 'reporting_instances'
    `,
    );
    expect(String(row?.["opts"])).toContain("security_invoker=true");
  });
});

describe("reporting role is bounded by tenant and by own rows", () => {
  it("returns nothing for a tenant that owns no rows, rather than erroring", async () => {
    // Zero rows, not an error: an error that names the shape confirms the row
    // exists somewhere, which is the thing tenant isolation must not leak.
    const rows = await asAnalyst(
      { tenant: TENANT_B },
      (tx) => tx`
      SELECT count(*)::int AS n FROM entity_instances WHERE tenant_id = ${TENANT_A}
    `,
    );
    expect(rows[0]?.["n"]).toBe(0);
  });

  it("returns nothing on a connection with no tenant stamped", async () => {
    // A FRESH connection on purpose. Superset opens one per query (NullPool,
    // verified in docker/superset/superset_config.py), so an unstamped caller
    // reads app.tenant_id as NULL, every policy evaluates false, and the
    // answer is zero rows.
    //
    // Reusing a connection that has already had the GUC set would instead
    // throw `invalid input syntax for type uuid: ""`, because once a custom
    // GUC has been initialised its reset value is the empty string, not NULL,
    // and entity_instances.tenant_read casts without a guard. Migration 0090
    // fixed exactly that on api_keys with nullif(current_setting(...), '')
    // and the tenant tables were never given the same treatment. It fails
    // closed either way, so it is a stated-invariant problem ("zero rows, not
    // an error") rather than an exposure — recorded, not fixed here.
    const fresh = postgres(ANALYTICS_URL, { max: 1, onnotice: () => {} });
    try {
      const rows = await fresh`
        SELECT count(*)::int AS n FROM entity_instances WHERE tenant_id = ${TENANT_A}
      `;
      expect(rows[0]?.["n"]).toBe(0);
    } finally {
      await fresh.end({ timeout: 5 });
    }
  });

  it("narrows a non-staff session to its own tickets", async () => {
    const rows = await asAnalyst(
      { tenant: TENANT_A, scope: "own", userId: OWNER },
      (tx) => tx`
        SELECT reporting_title FROM entity_instances WHERE deleted_at IS NULL
      `,
    );
    expect(rows.map((r) => r["reporting_title"])).toEqual([
      "Reporting iso mine",
    ]);
  });

  it("narrows a non-staff session to events on its own tickets", async () => {
    // The second block of migration 0116: events are scoped by the ticket
    // they belong to, not by who acted.
    const rows = await asAnalyst(
      { tenant: TENANT_A, scope: "own", userId: OWNER },
      (tx) => tx`
        SELECT comment FROM workflow_events WHERE workflow_id = ${workflowAId}
      `,
    );
    expect(rows.map((r) => r["comment"])).toEqual([
      `Reporting iso event for ${OWNER}`,
    ]);
  });

  it("gives a staff session every event in its tenant", async () => {
    const rows = await asAnalyst(
      { tenant: TENANT_A },
      (tx) => tx`
        SELECT comment FROM workflow_events WHERE workflow_id = ${workflowAId}
      `,
    );
    expect(rows).toHaveLength(2);
  });

  it("does not bypass row-level security", async () => {
    const [row] = await asAnalyst(
      {},
      (tx) => tx`
      SELECT rolbypassrls FROM pg_roles WHERE rolname = 'analytics_user'
    `,
    );
    expect(row?.["rolbypassrls"]).toBe(false);
  });
});

describe("derived reporting columns cannot drift from the payload they mirror", () => {
  it("keeps the projections equal to their source on insert", async () => {
    // The projections are maintained by trigger precisely so a later edit
    // cannot leave a chart reading a stale value. Checked through the owning
    // connection, since the reporting role may not read the payload side.
    const rows = await db.execute(dsql`
      SELECT count(*)::int AS drifted FROM entity_instances
       WHERE reporting_title      IS DISTINCT FROM (fields->>'title')
          OR reporting_department IS DISTINCT FROM (fields->>'department')
          OR reporting_priority   IS DISTINCT FROM (fields->>'priority')`);
    const first = (rows as unknown as Array<{ drifted: number }>)[0];
    expect(Number(first?.drifted ?? -1)).toBe(0);
  });
});

describe("record_reporting_audit cannot write another tenant's audit trail", () => {
  it("refuses a record whose tenant is not the session's tenant", async () => {
    // Stamped as Tenant A, claiming Tenant B: a forged call.
    await expect(
      asAnalyst(
        { tenant: TENANT_A },
        (tx) => tx`
        SELECT public.record_reporting_audit(
          ${TENANT_B}::uuid, 'forger', 'reporting.query_executed', '{}'::jsonb)
      `,
      ),
    ).rejects.toThrow(/does not match the session tenant/);
  });

  it("refuses a record from a connection with no tenant stamped", async () => {
    await expect(
      asAnalyst(
        {},
        (tx) => tx`
        SELECT public.record_reporting_audit(
          ${TENANT_A}::uuid, 'unstamped', 'reporting.query_executed', '{}'::jsonb)
      `,
      ),
    ).rejects.toThrow(/no session tenant/);
  });

  it("refuses a NULL tenant from an unstamped connection", async () => {
    // NULL IS DISTINCT FROM NULL is false, so a bare comparison would let
    // this through; the explicit session-tenant check must catch it.
    await expect(
      asAnalyst(
        {},
        (tx) => tx`
        SELECT public.record_reporting_audit(
          NULL::uuid, 'null-tenant', 'reporting.query_executed', '{}'::jsonb)
      `,
      ),
    ).rejects.toThrow(/no session tenant/);
  });

  it("refuses a NULL tenant from a stamped connection", async () => {
    await expect(
      asAnalyst(
        { tenant: TENANT_A },
        (tx) => tx`
        SELECT public.record_reporting_audit(
          NULL::uuid, 'null-tenant', 'reporting.query_executed', '{}'::jsonb)
      `,
      ),
    ).rejects.toThrow(/does not match the session tenant/);
  });

  it("writes the record when the tenant matches the session", async () => {
    const actor = `reporting-iso-audit-${Date.now()}`;
    await asAnalyst(
      { tenant: TENANT_A },
      (tx) => tx`
      SELECT public.record_reporting_audit(
        ${TENANT_A}::uuid, ${actor}, 'reporting.query_executed', '{}'::jsonb)
    `,
    );
    const rows = await db.execute(dsql`
      SELECT tenant_id FROM admin_audit_log WHERE actor_id = ${actor}`);
    const found = rows as unknown as Array<{ tenant_id: string }>;
    expect(found.map((r) => r.tenant_id)).toEqual([TENANT_A]);
    await db.execute(
      dsql`DELETE FROM admin_audit_log WHERE actor_id = ${actor}`,
    );
  });
});
