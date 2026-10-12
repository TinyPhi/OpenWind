/**
 * T19 (docs/specs/multi-org-sandbox.md): GET /platform-admin/sandboxes and
 * /sandboxes/:tenantId read across tenants through platform_admin_role. Real Postgres --
 * only the platform-admin auth middleware is stubbed (its own tests live in
 * packages/auth). platform-admin-role.isolation.test.ts covers the role's grants directly;
 * this covers the routes: they never surface a non-sandbox tenant, and return only the
 * allow-listed view fields.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { inArray } from "drizzle-orm";
import { db, tenants } from "@platform/db";
import type * as PlatformAuth from "@platform/auth";
import type { PlatformAdminAuthContext } from "@platform/auth";

vi.mock("@platform/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof PlatformAuth>();
  return {
    ...actual,
    requirePlatformAdmin:
      () =>
      async (
        c: Context<{ Variables: { platformAdmin: PlatformAdminAuthContext } }>,
        next: Next,
      ) => {
        c.set("platformAdmin", {
          userId: "pa-isolation",
          roles: ["platform_admin"],
          email: "pa@example.com",
          displayName: "PA",
        });
        await next();
      },
  };
});

const { sandboxListHandler, sandboxDetailHandler } =
  await import("../../src/routes/platform-admin/sandboxes-list.js");

const SANDBOX_TENANT = "eeeeeeee-0191-4000-e000-000000000191";
const REGULAR_TENANT = "ffffffff-0191-4000-f000-000000000191";
const VIEW_FIELDS = ["createdAt", "id", "isSandbox", "name", "trialStatus"];

function makeApp(): Hono {
  const app = new Hono();
  app.get("/sandboxes", ...sandboxListHandler);
  app.get("/sandboxes/:tenantId", ...sandboxDetailHandler);
  return app;
}

beforeAll(async () => {
  await db
    .insert(tenants)
    .values([
      {
        id: SANDBOX_TENANT,
        name: "T19 list isolation sandbox",
        slug: `t19-list-sandbox-${Date.now()}`,
        isSandbox: true,
        config: { secret_marker: "must-not-leak" },
      },
      {
        id: REGULAR_TENANT,
        name: "T19 list isolation regular tenant",
        slug: `t19-list-regular-${Date.now()}`,
      },
    ])
    .onConflictDoNothing();
});

afterAll(async () => {
  await db
    .delete(tenants)
    .where(inArray(tenants.id, [SANDBOX_TENANT, REGULAR_TENANT]));
});

describe("platform-admin sandbox list/detail routes (T19)", () => {
  it("lists the sandbox but never a regular tenant, with only the allow-listed fields", async () => {
    const res = await makeApp().request("/sandboxes");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown>[] };
    const ids = body.data.map((s) => s.id);
    expect(ids).toContain(SANDBOX_TENANT);
    expect(ids).not.toContain(REGULAR_TENANT);
    for (const item of body.data) {
      expect(Object.keys(item).sort()).toEqual(VIEW_FIELDS);
      expect(item.isSandbox).toBe(true);
    }
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
  });

  it("returns the sandbox's view by id", async () => {
    const res = await makeApp().request(`/sandboxes/${SANDBOX_TENANT}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.id).toBe(SANDBOX_TENANT);
    expect(Object.keys(body.data).sort()).toEqual(VIEW_FIELDS);
  });

  it("returns 404, not the row, for a regular tenant's id", async () => {
    const res = await makeApp().request(`/sandboxes/${REGULAR_TENANT}`);

    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain(REGULAR_TENANT);
  });
});
