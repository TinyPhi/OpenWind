/**
 * Isolation tests for PATCH /admin/tenants/:id/retention (#637, ADR-015).
 *
 * Real Postgres, no DB mocks. Only Zitadel token introspection is stubbed (there is no
 * Zitadel here); the role gate, the platform-operator fence, the validation, the jsonb merge
 * and the audit write all run for real.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { eq, inArray } from "drizzle-orm";
import { db, tenants, adminAuditLog, withTenantContext } from "@platform/db";
import type { AuthContext } from "@platform/auth";
import { env } from "@platform/config";

vi.mock("@platform/auth", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    requireIntrospection: () => async (_c: Context, next: Next) => {
      await next();
    },
  };
});

const { updateTenantRetentionHandlers } =
  await import("../../src/routes/admin/tenants.js");

const PLATFORM = "aaaaaaaa-0000-4000-a000-000000000070";
const TENANT_A = "aaaaaaaa-2222-4000-a000-000000000f71";
const TENANT_B = "aaaaaaaa-2222-4000-a000-000000000f72";

let originalPlatformOrgId: string | undefined;
let originalNodeEnv: string;

async function readConfig(id: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ config: tenants.config })
    .from(tenants)
    .where(eq(tenants.id, id));
  return (row?.config ?? {}) as Record<string, unknown>; // jsonb column, shape asserted by each test
}

beforeAll(async () => {
  originalPlatformOrgId = env.PLATFORM_ORG_ID;
  originalNodeEnv = env.NODE_ENV;
  env.PLATFORM_ORG_ID = PLATFORM;
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Retention A",
      slug: `retention-a-${TENANT_A}`,
      config: { rate_limit_per_min: 900, retention_days: 120 },
    },
    {
      id: TENANT_B,
      name: "Retention B",
      slug: `retention-b-${TENANT_B}`,
      config: { retention_days: 200 },
    },
  ]);
});

afterAll(async () => {
  env.PLATFORM_ORG_ID = originalPlatformOrgId;
  env.NODE_ENV = originalNodeEnv;
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
});

function makeApp(roles: string[], callerTenantId: string = PLATFORM) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId: callerTenantId,
        userId: "isolation-test-user",
        roles,
        email: "test@example.com",
      });
      await next();
    },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.patch("/:id/retention", ...(updateTenantRetentionHandlers as any));
  return app;
}

const patch = (
  app: Hono<{ Variables: { auth: AuthContext } }>,
  id: string,
  body: unknown,
) =>
  app.request(`/${id}/retention`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("PATCH /admin/tenants/:id/retention", () => {
  it("is forbidden to non-superadmin roles", async () => {
    for (const role of ["agent", "admin"]) {
      const res = await patch(makeApp([role]), TENANT_A, {
        retention_days: 200,
      });
      expect(res.status).toBe(403);
    }
  });

  it("changes only the targeted tenant and keeps other config keys", async () => {
    const res = await patch(makeApp(["superadmin"]), TENANT_A, {
      retention_days: 150,
      retention_hold: true,
    });
    expect(res.status).toBe(200);

    expect(await readConfig(TENANT_A)).toEqual({
      rate_limit_per_min: 900,
      retention_days: 150,
      retention_hold: true,
    });
    expect(await readConfig(TENANT_B)).toEqual({ retention_days: 200 });
  });

  it("refuses a tenant's own superadmin from touching another tenant (404, nothing changed)", async () => {
    const res = await patch(makeApp(["superadmin"], TENANT_A), TENANT_B, {
      retention_days: 365,
    });
    expect(res.status).toBe(404);
    expect(await readConfig(TENANT_B)).toEqual({ retention_days: 200 });
  });

  it("refuses every non-operator caller in production when no platform org is set", async () => {
    env.PLATFORM_ORG_ID = undefined;
    env.NODE_ENV = "production";
    try {
      for (const caller of [PLATFORM, TENANT_A, TENANT_B]) {
        const res = await patch(makeApp(["superadmin"], caller), TENANT_B, {
          retention_days: 365,
        });
        expect(res.status).toBe(404);
      }
      expect(await readConfig(TENANT_B)).toEqual({ retention_days: 200 });
    } finally {
      env.PLATFORM_ORG_ID = PLATFORM;
      env.NODE_ENV = originalNodeEnv;
    }
  });

  it("requires confirmShorten to shorten, and writes nothing when it is missing", async () => {
    const before = await readConfig(TENANT_B);
    const refused = await patch(makeApp(["superadmin"]), TENANT_B, {
      retention_days: 30,
    });
    expect(refused.status).toBe(422);
    expect(await readConfig(TENANT_B)).toEqual(before);

    const lengthened = await patch(makeApp(["superadmin"]), TENANT_B, {
      retention_days: 400,
    });
    expect(lengthened.status).toBe(200);

    const confirmed = await patch(makeApp(["superadmin"]), TENANT_B, {
      retention_days: 30,
      confirmShorten: true,
    });
    expect(confirmed.status).toBe(200);
    expect((await readConfig(TENANT_B))["retention_days"]).toBe(30);
  });

  it("treats clearing an override as shortening when the default is shorter", async () => {
    // TENANT_B is at 30 now, default is 90: clearing lengthens, so no confirmation.
    const res = await patch(makeApp(["superadmin"]), TENANT_B, {
      retention_days: null,
    });
    expect(res.status).toBe(200);
    expect(await readConfig(TENANT_B)).toEqual({});
  });

  it("rejects out-of-bounds values and an empty body", async () => {
    for (const body of [{}, { retention_days: 1 }, { retention_days: 99999 }]) {
      const res = await patch(makeApp(["superadmin"]), TENANT_A, body);
      expect(res.status).toBe(400);
    }
  });

  it("404s for an unknown tenant", async () => {
    const res = await patch(
      makeApp(["superadmin"]),
      "aaaaaaaa-9999-4000-a000-000000000f99",
      { retention_days: 400 },
    );
    expect(res.status).toBe(404);
  });

  it("records before and after values in the tenant's audit log", async () => {
    await patch(makeApp(["superadmin"]), TENANT_A, { retention_days: 500 });
    const rows = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select()
        .from(adminAuditLog)
        .where(eq(adminAuditLog.tenantId, TENANT_A)),
    );
    const last = rows.find(
      (r) =>
        r.action === "updated" &&
        r.resourceType === "tenant" &&
        (r.afterSnapshot as Record<string, unknown> | null)?.[
          "retention_days"
        ] === 500, // jsonb snapshot, narrowed for the lookup only
    );
    expect(last?.afterSnapshot).toEqual({ retention_days: 500 });
    expect(last?.beforeSnapshot).toEqual({ retention_days: 150 });
    expect(last?.actorId).toBe("isolation-test-user");
  });
});
