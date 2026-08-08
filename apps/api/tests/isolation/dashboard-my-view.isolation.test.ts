/**
 * Isolation tests for GET /dashboard/my-view (docs/specs/personal-dashboard.md).
 *
 * The endpoint has no dedicated RLS policy of its own — it delegates entirely
 * to resolveUserScopedEntityIds() (apps/api/src/routes/entities/scoped-access.ts),
 * the same predicate my-tickets.ts uses. These tests prove that delegation
 * actually enforces tenant + user scoping end-to-end via the real handler and
 * a real Postgres instance (no mocks) — not just that the helper's SQL looks right.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import {
  db,
  withTenantContext,
  entityInstances,
  entityTypes,
} from "@platform/db";
import { createEntity } from "@platform/entity-engine";
import type { AuthContext } from "@platform/auth";
import { myViewHandler } from "../../src/routes/dashboard/my-view.js";

const TENANT_A = "aaaaaaaa-0000-4000-a000-000000000041";
const TENANT_B = "bbbbbbbb-0000-4000-b000-000000000042";

const USER_A1 = "user-a1-dashboard-test";
const USER_A2 = "user-a2-dashboard-test";
const USER_B1 = "user-b1-dashboard-test";

let entityTypeId: string;
let instanceA1Id: string; // Tenant A, assigned to USER_A1, has a due date
let instanceA2Id: string; // Tenant A, assigned to USER_A2
let instanceB1Id: string; // Tenant B, assigned to USER_B1 (same literal id string reused across tenants is not tested here — distinct users)

beforeAll(async () => {
  const [etRow] = await db
    .insert(entityTypes)
    .values({
      tenantId: null,
      name: `isolation_dashboard_${Date.now()}`,
      plural: `isolation_dashboards_${Date.now()}`,
      allowCustomFields: true,
    })
    .returning();
  if (!etRow) throw new Error("entity type insert failed");
  entityTypeId = etRow.id;

  const instA1 = await withTenantContext(TENANT_A, (tx) =>
    createEntity(tx, TENANT_A, {
      entityTypeId,
      fields: { title: "Tenant A ticket" },
      assignedTo: USER_A1,
      dueDate: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  );
  instanceA1Id = instA1.id;

  const instA2 = await withTenantContext(TENANT_A, (tx) =>
    createEntity(tx, TENANT_A, {
      entityTypeId,
      fields: { title: "Tenant A, User A2 ticket" },
      assignedTo: USER_A2,
    }),
  );
  instanceA2Id = instA2.id;

  const instB1 = await withTenantContext(TENANT_B, (tx) =>
    createEntity(tx, TENANT_B, {
      entityTypeId,
      fields: { title: "Tenant B ticket" },
      assignedTo: USER_B1,
      dueDate: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  );
  instanceB1Id = instB1.id;
});

afterAll(async () => {
  await db
    .delete(entityInstances)
    .where(eq(entityInstances.entityTypeId, entityTypeId));
  await db.delete(entityTypes).where(eq(entityTypes.id, entityTypeId));
});

function makeApp(tenantId: string, userId: string) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId,
        userId,
        roles: ["user"],
        email: "t@example.com",
      });
      await next();
    },
  );
  app.get("/my-view", ...myViewHandler);
  return app;
}

describe("GET /dashboard/my-view — cross-tenant isolation", () => {
  it("Tenant B's user never sees Tenant A's ticket in dueDates, even though it has a due date", async () => {
    const res = await makeApp(TENANT_B, USER_B1).request("/my-view");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { dueDates: { items: { entityId: string }[] } };
    };
    expect(data.dueDates.items.map((i) => i.entityId)).not.toContain(
      instanceA1Id,
    );
  });

  it("Tenant A's user never sees Tenant B's ticket, even under the identically-shaped query", async () => {
    const res = await makeApp(TENANT_A, USER_A1).request("/my-view");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { dueDates: { items: { entityId: string }[] } };
    };
    expect(data.dueDates.items.map((i) => i.entityId)).not.toContain(
      instanceB1Id,
    );
  });
});

describe("GET /dashboard/my-view — cross-user isolation within the same tenant", () => {
  it("User A1 sees their own ticket in Tenant A, but not User A2's (no due date on A2's ticket anyway)", async () => {
    const res = await makeApp(TENANT_A, USER_A1).request("/my-view");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { dueDates: { items: { entityId: string }[] } };
    };
    const ids = data.dueDates.items.map((i) => i.entityId);
    expect(ids).toContain(instanceA1Id);
    expect(ids).not.toContain(instanceA2Id);
  });

  it("User A2 does not see User A1's due-date ticket within the same tenant", async () => {
    const res = await makeApp(TENANT_A, USER_A2).request("/my-view");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { dueDates: { items: { entityId: string }[] } };
    };
    expect(data.dueDates.items.map((i) => i.entityId)).not.toContain(
      instanceA1Id,
    );
  });

  it("a user with zero scoped tickets gets fully empty sections, not an error", async () => {
    const res = await makeApp(TENANT_A, "user-with-nothing").request(
      "/my-view",
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: {
        workflows: unknown[];
        dueDates: { items: unknown[] };
        slaRisk: { items: unknown[] };
      };
    };
    expect(data.workflows).toEqual([]);
    expect(data.dueDates.items).toEqual([]);
    expect(data.slaRisk.items).toEqual([]);
  });
});
