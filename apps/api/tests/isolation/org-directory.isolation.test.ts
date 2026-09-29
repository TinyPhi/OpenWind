/**
 * Tenant isolation tests for org_employees / org_directory_sync_runs.
 *
 * docs/specs/org-directory.md T3. DB-level only (no routes/query API exist yet
 * in this PR — see the full-surface version added alongside T6/T9 once the
 * query API and routes land). Modeled on teams.isolation.test.ts.
 * Requires a live Postgres instance (run with docker compose up -d).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, inArray, sql } from "drizzle-orm";
import {
  db,
  withTenantContext,
  orgEmployees,
  orgDirectorySyncRuns,
  tenants,
} from "@platform/db";

const TENANT_A = "aaaaaaaa-org1-4000-a000-000000000001";
const TENANT_B = "bbbbbbbb-org1-4000-b000-000000000002";
const USER_A = "aaaaaaaa-org1-4000-a000-000000000900";
const USER_B = "bbbbbbbb-org1-4000-b000-000000000900";

let rootAId: string;
let rootBId: string;
let employeeAId: string;
let employeeBId: string;

beforeAll(async () => {
  // org_employees.tenant_id REFERENCES tenants(id) -- real tenant rows required.
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Org Directory Isolation Test A",
      slug: `org-directory-isolation-a-${TENANT_A}`,
    },
    {
      id: TENANT_B,
      name: "Org Directory Isolation Test B",
      slug: `org-directory-isolation-b-${TENANT_B}`,
    },
  ]);

  const [rootA] = await db
    .insert(orgEmployees)
    .values({
      tenantId: TENANT_A,
      userId: null,
      name: "Org Directory Isolation Test A",
      isRoot: true,
    })
    .returning({ id: orgEmployees.id });
  const [rootB] = await db
    .insert(orgEmployees)
    .values({
      tenantId: TENANT_B,
      userId: null,
      name: "Org Directory Isolation Test B",
      isRoot: true,
    })
    .returning({ id: orgEmployees.id });
  rootAId = rootA!.id;
  rootBId = rootB!.id;

  const [employeeA] = await db
    .insert(orgEmployees)
    .values({
      tenantId: TENANT_A,
      userId: USER_A,
      parentId: rootAId,
      name: "Employee A",
    })
    .returning({ id: orgEmployees.id });
  const [employeeB] = await db
    .insert(orgEmployees)
    .values({
      tenantId: TENANT_B,
      userId: USER_B,
      parentId: rootBId,
      name: "Employee B",
    })
    .returning({ id: orgEmployees.id });
  employeeAId = employeeA!.id;
  employeeBId = employeeB!.id;

  await db.insert(orgDirectorySyncRuns).values([
    { tenantId: TENANT_A, status: "completed", triggeredBy: USER_A },
    { tenantId: TENANT_B, status: "completed", triggeredBy: USER_B },
  ]);
});

afterAll(async () => {
  await db
    .delete(orgDirectorySyncRuns)
    .where(inArray(orgDirectorySyncRuns.tenantId, [TENANT_A, TENANT_B]));
  // Children before parents -- parentId has no ON DELETE action.
  await db
    .delete(orgEmployees)
    .where(inArray(orgEmployees.id, [employeeAId, employeeBId]));
  await db
    .delete(orgEmployees)
    .where(inArray(orgEmployees.id, [rootAId, rootBId]));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
});

describe("org_employees — cross-tenant READ isolation", () => {
  it("Tenant A's read scoped to Tenant A does not return Tenant B's employee", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ id: orgEmployees.id })
        .from(orgEmployees)
        .where(
          and(
            eq(orgEmployees.id, employeeBId),
            eq(orgEmployees.tenantId, TENANT_A),
          ),
        );
      expect(rows).toHaveLength(0);
    });
  });

  it("Tenant A can read its own root and employee", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ id: orgEmployees.id })
        .from(orgEmployees)
        .where(eq(orgEmployees.tenantId, TENANT_A));
      expect(rows.map((r) => r.id)).toEqual(
        expect.arrayContaining([rootAId, employeeAId]),
      );
    });
  });

  it("RLS blocks a raw cross-tenant SELECT under app_user role", async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      await tx.execute(
        sql`SELECT set_config('app.tenant_id', ${TENANT_A}, true)`,
      );
      return tx
        .select({ id: orgEmployees.id })
        .from(orgEmployees)
        .where(eq(orgEmployees.id, employeeBId));
    });
    expect(rows).toHaveLength(0);
  });
});

describe("org_employees — cross-tenant WRITE isolation", () => {
  it("RLS blocks inserting a row tagged with a different tenant_id under app_user role", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.execute(
          sql`SELECT set_config('app.tenant_id', ${TENANT_A}, true)`,
        );
        await tx.insert(orgEmployees).values({
          tenantId: TENANT_B,
          userId: "smuggled-user",
          name: "Smuggled Employee",
        });
      }),
    ).rejects.toBeTruthy();
  });
});

describe("org_employees — schema invariants", () => {
  it("rejects a second root row for the same tenant", async () => {
    await expect(
      db.insert(orgEmployees).values({
        tenantId: TENANT_A,
        userId: null,
        name: "Second Root",
        isRoot: true,
      }),
    ).rejects.toBeTruthy();
  });

  it("rejects a second row for the same (tenant, user)", async () => {
    await expect(
      db.insert(orgEmployees).values({
        tenantId: TENANT_A,
        userId: USER_A,
        parentId: rootAId,
        name: "Duplicate Employee A",
      }),
    ).rejects.toBeTruthy();
  });
});

describe("org_directory_sync_runs — cross-tenant READ isolation", () => {
  it("Tenant A's read scoped to Tenant A does not return Tenant B's sync run", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ tenantId: orgDirectorySyncRuns.tenantId })
        .from(orgDirectorySyncRuns)
        .where(eq(orgDirectorySyncRuns.tenantId, TENANT_A));
      expect(rows.every((r) => r.tenantId === TENANT_A)).toBe(true);
    });
  });

  it("rejects a second concurrent 'running' sync row for the same tenant", async () => {
    await db.insert(orgDirectorySyncRuns).values({
      tenantId: TENANT_A,
      status: "running",
    });
    await expect(
      db.insert(orgDirectorySyncRuns).values({
        tenantId: TENANT_A,
        status: "running",
      }),
    ).rejects.toBeTruthy();
    await db
      .delete(orgDirectorySyncRuns)
      .where(
        and(
          eq(orgDirectorySyncRuns.tenantId, TENANT_A),
          eq(orgDirectorySyncRuns.status, "running"),
        ),
      );
  });
});
