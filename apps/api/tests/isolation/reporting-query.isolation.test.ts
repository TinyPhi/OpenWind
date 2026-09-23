/**
 * Isolation tests for POST /reporting/query (the in-app query builder).
 *
 * The route builds its SQL from user-chosen measures, groupings and filters,
 * so the tenant and own-rows boundaries have to hold whatever the caller
 * sends. These tests run the real handler against a real Postgres instance —
 * the route's unit tests (src/routes/reporting/query.test.ts) mock the
 * database, so they cannot prove the SQL itself is scoped.
 *
 * Only the Zitadel user lookup is mocked: it resolves display names and has
 * no bearing on which rows are returned.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { db, entityInstances, entityTypes } from "@platform/db";
import type { AuthContext } from "@platform/auth";

vi.mock("../../src/lib/zitadel-management.js", () => ({
  listOrgUsers: vi.fn().mockResolvedValue([]),
}));

const { executeBYOQueryHandler } =
  await import("../../src/routes/reporting/query.js");

const TENANT_A = "aaaaaaaa-0000-4000-a000-000000000126";
const TENANT_B = "bbbbbbbb-0000-4000-b000-000000000127";

const USER_A1 = "user-a1-reporting-query-test";
const USER_A2 = "user-a2-reporting-query-test";
const USER_B1 = "user-b1-reporting-query-test";

/** A value only Tenant B's ticket carries, so a filter on it can only reach B. */
const B_ONLY_DEPARTMENT = "reporting-query-iso-b-only";

let entityTypeId: string;
let instanceA1Id: string; // Tenant A, assigned to USER_A1
let instanceA2Id: string; // Tenant A, assigned to USER_A2
let instanceB1Id: string; // Tenant B, assigned to USER_B1

beforeAll(async () => {
  const [etRow] = await db
    .insert(entityTypes)
    .values({
      tenantId: null,
      name: `isolation_reporting_query_${Date.now()}`,
      plural: `isolation_reporting_queries_${Date.now()}`,
      allowCustomFields: true,
    })
    .returning();
  if (!etRow) throw new Error("entity type insert failed");
  entityTypeId = etRow.id;

  // Inserted directly rather than through createEntity: the engine keeps only
  // fields the entity type defines, and this throwaway type defines none, so
  // the department the filter test relies on would be dropped.
  const insert = async (
    tenantId: string,
    title: string,
    userId: string,
    department?: string,
  ): Promise<string> => {
    const [row] = await db
      .insert(entityInstances)
      .values({
        entityTypeId,
        tenantId,
        currentState: "open",
        fields: department ? { title, department } : { title },
        createdBy: userId,
        assignedTo: userId,
      })
      .returning();
    if (!row) throw new Error("entity instance insert failed");
    return row.id;
  };
  instanceA1Id = await insert(TENANT_A, "Reporting query A1", USER_A1);
  instanceA2Id = await insert(TENANT_A, "Reporting query A2", USER_A2);
  instanceB1Id = await insert(
    TENANT_B,
    "Reporting query B1",
    USER_B1,
    B_ONLY_DEPARTMENT,
  );
});

afterAll(async () => {
  await db
    .delete(entityInstances)
    .where(eq(entityInstances.entityTypeId, entityTypeId));
  await db.delete(entityTypes).where(eq(entityTypes.id, entityTypeId));
});

function makeApp(tenantId: string, userId: string, role: string) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId,
        userId,
        roles: [role],
        email: "t@example.com",
      });
      await next();
    },
  );
  app.post("/query", ...executeBYOQueryHandler);
  return app;
}

type QueryResponse = {
  data: { summary: { totalRows: number }; rows: { id: string }[] };
};

async function query(
  app: ReturnType<typeof makeApp>,
  body: Record<string, unknown> = {},
): Promise<QueryResponse["data"]> {
  const res = await app.request("/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit: 500, ...body }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as QueryResponse).data;
}

/** Only this test's own rows — the shared test database holds other tickets. */
function ours(ids: string[]): string[] {
  const mine = new Set([instanceA1Id, instanceA2Id, instanceB1Id]);
  return ids.filter((id) => mine.has(id)).sort();
}

describe("POST /reporting/query — cross-tenant isolation", () => {
  it("an admin in Tenant A sees Tenant A's tickets and never Tenant B's", async () => {
    const data = await query(makeApp(TENANT_A, USER_A1, "admin"));
    expect(ours(data.rows.map((r) => r.id))).toEqual(
      [instanceA1Id, instanceA2Id].sort(),
    );
  });

  it("an admin in Tenant B sees only Tenant B's ticket", async () => {
    const data = await query(makeApp(TENANT_B, USER_B1, "admin"));
    expect(ours(data.rows.map((r) => r.id))).toEqual([instanceB1Id]);
  });

  it("a filter matching only another tenant's ticket returns nothing", async () => {
    // Sanity check first: the same filter does find the ticket inside its own
    // tenant, so an empty result below means isolation, not a broken filter.
    const own = await query(makeApp(TENANT_B, USER_B1, "admin"), {
      filters: [
        { field: "department", operator: "equals", value: B_ONLY_DEPARTMENT },
      ],
    });
    expect(ours(own.rows.map((r) => r.id))).toEqual([instanceB1Id]);

    const data = await query(makeApp(TENANT_A, USER_A1, "admin"), {
      filters: [
        { field: "department", operator: "equals", value: B_ONLY_DEPARTMENT },
      ],
    });
    expect(data.rows).toEqual([]);
    expect(data.summary.totalRows).toBe(0);
  });
});

describe("POST /reporting/query — own rows for non-staff", () => {
  it("a user sees only tickets assigned to or raised by them", async () => {
    const data = await query(makeApp(TENANT_A, USER_A1, "user"));
    expect(ours(data.rows.map((r) => r.id))).toEqual([instanceA1Id]);
  });

  it("a user cannot widen their scope with a filter on another user", async () => {
    const data = await query(makeApp(TENANT_A, USER_A1, "user"), {
      filters: [{ field: "assignee", operator: "equals", value: USER_A2 }],
    });
    expect(ours(data.rows.map((r) => r.id))).toEqual([]);
  });
});
