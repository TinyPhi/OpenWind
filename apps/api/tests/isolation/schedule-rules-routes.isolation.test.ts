/**
 * Tenant isolation tests for the /admin/schedule-rules ROUTES (PR #595) --
 * schedule-rules.isolation.test.ts only exercises the raw tables via
 * withTenantContext, not the actual HTTP routes. Mirrors the pattern
 * established in labels-and-notification-policies-routes.isolation.test.ts
 * and canvas.isolation.test.ts: mount the real router behind a
 * pre-populated `auth` context (requireAuth short-circuits when
 * `c.get("auth")` is already set), issue real HTTP requests against a real
 * Postgres instance (run with docker compose up -d).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { db, tenants, entityTypes, scheduleRules } from "@platform/db";
import type { AuthContext } from "@platform/auth";
import { scheduleRulesRouter } from "../../src/routes/admin/schedule-rules.js";

const TENANT_A = "aaaaaaaa-8888-4000-a000-000000000001";
const TENANT_B = "bbbbbbbb-8888-4000-b000-000000000002";

let entityTypeId: string;

function makeApp(tenantId: string, roles: string[]) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId,
        userId: "u-test",
        roles,
        email: "test@example.com",
      });
      await next();
    },
  );
  app.route("/admin/schedule-rules", scheduleRulesRouter);
  return app;
}

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Schedule Routes A",
      slug: `schedule-routes-a-${TENANT_A}`,
    },
    {
      id: TENANT_B,
      name: "Schedule Routes B",
      slug: `schedule-routes-b-${TENANT_B}`,
    },
  ]);
  // Shared NULL-tenant "ticket" template, same convention as the real
  // helpdesk module's entity type -- validateScheduleRuleRefs requires
  // name === 'ticket'.
  const [et] = await db
    .insert(entityTypes)
    .values({
      tenantId: null,
      name: "ticket",
      plural: "Tickets",
      allowCustomFields: true,
    })
    .returning({ id: entityTypes.id });
  entityTypeId = et!.id;
});

afterAll(async () => {
  await db
    .delete(scheduleRules)
    .where(inArray(scheduleRules.tenantId, [TENANT_A, TENANT_B]));
  await db.delete(entityTypes).where(eq(entityTypes.id, entityTypeId));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
});

describe("schedule-rules router — tenant isolation", () => {
  it("Tenant B cannot read, update, or delete Tenant A's rule via the real route", async () => {
    const appA = makeApp(TENANT_A, ["admin"]);
    const createRes = await appA.request("/admin/schedule-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Route Isolation Rule",
        cronExpr: "0 9 1 * *",
        entityTypeId,
        template: { title: "Monthly Review" },
      }),
    });
    expect(createRes.status).toBe(201);
    const { data: created } = (await createRes.json()) as {
      data: { id: string };
    };

    const appB = makeApp(TENANT_B, ["admin"]);

    const getRes = await appB.request(`/admin/schedule-rules/${created.id}`);
    expect(getRes.status).toBe(404);

    const patchRes = await appB.request(`/admin/schedule-rules/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });
    expect(patchRes.status).toBe(404);

    const executionsRes = await appB.request(
      `/admin/schedule-rules/${created.id}/executions`,
    );
    expect(executionsRes.status).toBe(404);

    const deleteRes = await appB.request(
      `/admin/schedule-rules/${created.id}`,
      { method: "DELETE" },
    );
    expect(deleteRes.status).toBe(404);

    const listRes = await appB.request("/admin/schedule-rules");
    const { data: listB } = (await listRes.json()) as {
      data: { id: string }[];
    };
    expect(listB.some((r) => r.id === created.id)).toBe(false);
  });
});
