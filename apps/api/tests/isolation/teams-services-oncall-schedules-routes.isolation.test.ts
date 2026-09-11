/**
 * Tenant isolation tests for the /admin/teams, /admin/services, and
 * /admin/on-call-schedules ROUTES (PR #590) -- the existing
 * teams.isolation.test.ts / services.isolation.test.ts /
 * on-call-schedules.isolation.test.ts files only exercise the raw tables
 * via withTenantContext, not the actual HTTP routes. Mirrors
 * labels-and-notification-policies-routes.isolation.test.ts's pattern:
 * mount the real router behind a pre-populated `auth` context (requireAuth
 * short-circuits when `c.get("auth")` is already set), issue real HTTP
 * requests against a real Postgres instance (run with docker compose up -d).
 */

import { describe, it, expect, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import {
  db,
  tenants,
  tenantUsers,
  teams,
  services,
  onCallSchedules,
} from "@platform/db";
import type { AuthContext } from "@platform/auth";
import { teamsRouter } from "../../src/routes/admin/teams.js";
import { servicesRouter } from "../../src/routes/admin/services.js";
import { onCallSchedulesRouter } from "../../src/routes/admin/on-call-schedules.js";

const TENANT_A = "aaaaaaaa-9999-4000-a000-000000000001";
const TENANT_B = "bbbbbbbb-9999-4000-b000-000000000002";
const USER_A = "aaaaaaaa-9999-4000-a000-000000000900";
const USER_B = "bbbbbbbb-9999-4000-b000-000000000900";

function makeApp(tenantId: string, userId: string, roles: string[]) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId,
        userId,
        roles,
        email: "test@example.com",
      });
      await next();
    },
  );
  app.route("/admin/teams", teamsRouter);
  app.route("/admin/services", servicesRouter);
  app.route("/admin/on-call-schedules", onCallSchedulesRouter);
  return app;
}

afterAll(async () => {
  await db
    .delete(onCallSchedules)
    .where(inArray(onCallSchedules.tenantId, [TENANT_A, TENANT_B]));
  await db
    .delete(services)
    .where(inArray(services.tenantId, [TENANT_A, TENANT_B]));
  await db.delete(teams).where(inArray(teams.tenantId, [TENANT_A, TENANT_B]));
  await db
    .delete(tenantUsers)
    .where(inArray(tenantUsers.tenantId, [TENANT_A, TENANT_B]));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
});

describe("teams router — tenant isolation", () => {
  it("Tenant B cannot read, update, or delete Tenant A's team via the real route", async () => {
    await db.insert(tenants).values([
      {
        id: TENANT_A,
        name: "Teams Route A",
        slug: `teams-route-a-${TENANT_A}`,
      },
      {
        id: TENANT_B,
        name: "Teams Route B",
        slug: `teams-route-b-${TENANT_B}`,
      },
    ]);

    const appA = makeApp(TENANT_A, USER_A, ["admin"]);
    const createRes = await appA.request("/admin/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "route-isolation-team" }),
    });
    expect(createRes.status).toBe(201);
    const { data: created } = (await createRes.json()) as {
      data: { id: string };
    };

    const appB = makeApp(TENANT_B, USER_B, ["admin"]);

    const getRes = await appB.request(`/admin/teams/${created.id}`);
    expect(getRes.status).toBe(404);

    const patchRes = await appB.request(`/admin/teams/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "smuggled-rename" }),
    });
    expect(patchRes.status).toBe(404);

    const deleteRes = await appB.request(`/admin/teams/${created.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(404);

    const listRes = await appB.request("/admin/teams");
    const { data: listB } = (await listRes.json()) as {
      data: { id: string }[];
    };
    expect(listB.some((t) => t.id === created.id)).toBe(false);
  });
});

describe("services router — tenant isolation", () => {
  it("Tenant B cannot read, update, or delete Tenant A's service via the real route", async () => {
    const appA = makeApp(TENANT_A, USER_A, ["admin"]);
    const createRes = await appA.request("/admin/services", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "route-isolation-service" }),
    });
    expect(createRes.status).toBe(201);
    const { data: created } = (await createRes.json()) as {
      data: { id: string };
    };

    const appB = makeApp(TENANT_B, USER_B, ["admin"]);

    const getRes = await appB.request(`/admin/services/${created.id}`);
    expect(getRes.status).toBe(404);

    const patchRes = await appB.request(`/admin/services/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "smuggled-rename" }),
    });
    expect(patchRes.status).toBe(404);

    const deleteRes = await appB.request(`/admin/services/${created.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(404);

    const listRes = await appB.request("/admin/services");
    const { data: listB } = (await listRes.json()) as {
      data: { id: string }[];
    };
    expect(listB.some((s) => s.id === created.id)).toBe(false);
  });
});

describe("on-call-schedules router — tenant isolation", () => {
  it("Tenant B cannot read, update, or delete Tenant A's schedule via the real route", async () => {
    const [teamA] = await db
      .insert(teams)
      .values({
        tenantId: TENANT_A,
        name: "On-Call Route Team A",
        createdBy: USER_A,
      })
      .returning({ id: teams.id });
    await db.insert(tenantUsers).values({
      tenantId: TENANT_A,
      userId: USER_A,
      email: "usera@example.com",
      displayName: "User A",
    });

    const appA = makeApp(TENANT_A, USER_A, ["admin"]);
    const createRes = await appA.request("/admin/on-call-schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        teamId: teamA!.id,
        label: "Route Isolation Week",
        startsAt: "2026-11-01T00:00:00Z",
        endsAt: "2026-11-08T00:00:00Z",
        primaryUserId: USER_A,
      }),
    });
    expect(createRes.status).toBe(201);
    const { data: created } = (await createRes.json()) as {
      data: { id: string };
    };

    const appB = makeApp(TENANT_B, USER_B, ["admin"]);

    const getRes = await appB.request(`/admin/on-call-schedules/${created.id}`);
    expect(getRes.status).toBe(404);

    const patchRes = await appB.request(
      `/admin/on-call-schedules/${created.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "smuggled-rename" }),
      },
    );
    expect(patchRes.status).toBe(404);

    const deleteRes = await appB.request(
      `/admin/on-call-schedules/${created.id}`,
      { method: "DELETE" },
    );
    expect(deleteRes.status).toBe(404);

    const listRes = await appB.request("/admin/on-call-schedules");
    const { data: listB } = (await listRes.json()) as {
      data: { id: string }[];
    };
    expect(listB.some((s) => s.id === created.id)).toBe(false);
  });
});
