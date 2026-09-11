/**
 * Tenant isolation tests for the /admin/labels and
 * /admin/notification-policies ROUTES (PR #594) -- the existing
 * labels.isolation.test.ts / notification-policies.isolation.test.ts files
 * only exercise the raw tables via withTenantContext, not the actual HTTP
 * routes. Mirrors canvas.isolation.test.ts's pattern: mount the real router
 * behind a pre-populated `auth` context (requireAuth short-circuits when
 * `c.get("auth")` is already set), issue real HTTP requests against a real
 * Postgres instance (run with docker compose up -d).
 */

import { describe, it, expect, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { db, tenants, labels, notificationPolicies } from "@platform/db";
import type { AuthContext } from "@platform/auth";
import { labelsRouter } from "../../src/routes/admin/labels.js";
import { notificationPoliciesRouter } from "../../src/routes/admin/notification-policies.js";

const TENANT_A = "aaaaaaaa-7777-4000-a000-000000000001";
const TENANT_B = "bbbbbbbb-7777-4000-b000-000000000002";

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
  app.route("/admin/labels", labelsRouter);
  app.route("/admin/notification-policies", notificationPoliciesRouter);
  return app;
}

afterAll(async () => {
  await db.delete(labels).where(inArray(labels.tenantId, [TENANT_A, TENANT_B]));
  await db
    .delete(notificationPolicies)
    .where(inArray(notificationPolicies.tenantId, [TENANT_A, TENANT_B]));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
});

describe("labels router — tenant isolation", () => {
  it("Tenant B cannot read, update, or delete Tenant A's label via the real route", async () => {
    await db.insert(tenants).values([
      {
        id: TENANT_A,
        name: "Labels Route A",
        slug: `labels-route-a-${TENANT_A}`,
      },
      {
        id: TENANT_B,
        name: "Labels Route B",
        slug: `labels-route-b-${TENANT_B}`,
      },
    ]);

    const appA = makeApp(TENANT_A, ["admin"]);
    const createRes = await appA.request("/admin/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "route-isolation-label", color: "#123456" }),
    });
    expect(createRes.status).toBe(201);
    const { data: created } = (await createRes.json()) as {
      data: { id: string };
    };

    const appB = makeApp(TENANT_B, ["admin"]);

    const getRes = await appB.request(`/admin/labels/${created.id}`);
    expect(getRes.status).toBe(404);

    const patchRes = await appB.request(`/admin/labels/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "smuggled-rename" }),
    });
    expect(patchRes.status).toBe(404);

    const deleteRes = await appB.request(`/admin/labels/${created.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(404);

    const listRes = await appB.request("/admin/labels");
    const { data: listB } = (await listRes.json()) as {
      data: { id: string }[];
    };
    expect(listB.some((l) => l.id === created.id)).toBe(false);
  });
});

describe("notification-policies router — tenant isolation", () => {
  it("Tenant B cannot read, update, or delete Tenant A's policy via the real route, and /resolve never crosses tenants", async () => {
    const appA = makeApp(TENANT_A, ["admin"]);
    const createRes = await appA.request("/admin/notification-policies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ severity: "high", channels: ["email"] }),
    });
    expect(createRes.status).toBe(201);
    const { data: created } = (await createRes.json()) as {
      data: { id: string };
    };

    const appB = makeApp(TENANT_B, ["admin"]);

    const getRes = await appB.request(
      `/admin/notification-policies/${created.id}`,
    );
    expect(getRes.status).toBe(404);

    const patchRes = await appB.request(
      `/admin/notification-policies/${created.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channels: ["sms"] }),
      },
    );
    expect(patchRes.status).toBe(404);

    const deleteRes = await appB.request(
      `/admin/notification-policies/${created.id}`,
      { method: "DELETE" },
    );
    expect(deleteRes.status).toBe(404);

    // Tenant B's own /resolve for the same severity must fall through to
    // the hardcoded default, never see Tenant A's policy.
    const resolveRes = await appB.request(
      "/admin/notification-policies/resolve?severity=high",
    );
    expect(resolveRes.status).toBe(200);
    const { data: resolved } = (await resolveRes.json()) as {
      data: { policyId: string | null };
    };
    expect(resolved.policyId).not.toBe(created.id);
  });
});
