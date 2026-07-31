import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import { eq } from "drizzle-orm";
import { db, tenants, viewConfigs } from "@platform/db";
import { ModuleService } from "../../src/services/module-service.js";
import { createApp } from "../../src/app.js";

const TEST_TENANT_ID = "00000000-0000-0000-0000-000000000088";
let currentTenantId = TEST_TENANT_ID;

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (
      c: Context<{ Variables: { auth: AuthContext } }>,
      next: Next,
    ): Promise<void> => {
      c.set("auth", {
        tenantId: currentTenantId,
        userId: "u-test-admin",
        roles: ["admin"],
        email: "admin@test.com",
      });
      await next();
    },
  requireRole:
    (..._roles: string[]) =>
    async (c: Context, next: Next): Promise<void> => {
      await next();
    },
  requireIntrospection:
    () =>
    async (c: Context, next: Next): Promise<void> => {
      await next();
    },
}));

describe("View Configs Integration Tests", () => {
  let app: Hono;

  beforeAll(async () => {
    // Create test tenant
    await db
      .insert(tenants)
      .values({
        id: TEST_TENANT_ID,
        name: "Test View Config Tenant",
        slug: "test-view-config-tenant",
        plan: "standard",
        status: "active",
        config: {},
      })
      .onConflictDoNothing();

    app = createApp();
    await ModuleService.seedRegistry();
  });

  afterAll(async () => {
    // Clean up
    await db
      .delete(viewConfigs)
      .where(eq(viewConfigs.tenantId, TEST_TENANT_ID));
    await db.delete(tenants).where(eq(tenants.id, TEST_TENANT_ID));
  });

  it("GET /admin/view-configs/ticket - returns 404 before installation", async () => {
    currentTenantId = TEST_TENANT_ID;
    const res = await app.request("/admin/view-configs/ticket", {
      method: "GET",
    });
    expect(res.status).toBe(404);
  });

  it("POST /modules/helpdesk/install - successfully seeds default view configs", async () => {
    currentTenantId = TEST_TENANT_ID;
    const res = await app.request("/modules/helpdesk/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);

    // Now GET should work
    const getRes = await app.request("/admin/view-configs/ticket", {
      method: "GET",
    });
    expect(getRes.status).toBe(200);
    const { data: json } = (await getRes.json()) as {
      data: {
        entityTypeSlug: string;
        formFieldOrder: string[];
        listColumns: unknown[];
      };
    };
    expect(json.entityTypeSlug).toBe("ticket");
    expect(json.formFieldOrder).toContain("title");
    expect(json.listColumns.length).toBeGreaterThan(0);
  });

  it("PATCH /admin/view-configs/ticket - overrides layout configuration successfully", async () => {
    currentTenantId = TEST_TENANT_ID;
    // Ensure prerequisite view configs exist independently of test execution order
    await app.request("/modules/helpdesk/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const customList = [
      { field: "title", label: "Custom Title", width: 400, sortable: true },
    ];

    const patchRes = await app.request("/admin/view-configs/ticket", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        listColumns: customList,
      }),
    });

    expect(patchRes.status).toBe(200);
    const { data: json } = (await patchRes.json()) as {
      data: { listColumns: { label: string }[] };
    };
    expect(json.listColumns[0]?.label).toBe("Custom Title");

    // Fetch again and verify
    const getRes = await app.request("/admin/view-configs/ticket", {
      method: "GET",
    });
    const { data: getJson } = (await getRes.json()) as {
      data: { listColumns: { label: string }[]; formFieldOrder: string[] };
    };
    expect(getJson.listColumns[0]?.label).toBe("Custom Title");
    // Ensure existing fields not overridden by patch are kept (formFieldOrder, etc.)
    expect(getJson.formFieldOrder).toContain("title");
  });

  it("GET /admin/view-configs/ticket - isolates layout configs across tenants", async () => {
    const OTHER_TENANT = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    // Create other tenant
    await db
      .insert(tenants)
      .values({
        id: OTHER_TENANT,
        name: "Other Tenant",
        slug: "other-tenant",
        plan: "standard",
        status: "active",
        config: {},
      })
      .onConflictDoNothing();

    try {
      // Query as other tenant
      currentTenantId = OTHER_TENANT;
      const getRes = await app.request("/admin/view-configs/ticket", {
        method: "GET",
      });
      expect(getRes.status).toBe(404); // Not installed for this other tenant
    } finally {
      // Clean up
      await db
        .delete(viewConfigs)
        .where(eq(viewConfigs.tenantId, OTHER_TENANT));
      await db.delete(tenants).where(eq(tenants.id, OTHER_TENANT));
    }
  });
});
