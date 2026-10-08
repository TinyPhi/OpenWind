import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { PlatformAdminAuthContext } from "@platform/auth";

const { mockPlatformAdmin } = vi.hoisted(() => ({
  mockPlatformAdmin: {
    userId: "pa-1",
    roles: ["platform_admin"],
    email: "ops@openwind.io",
    displayName: "Ops",
  },
}));

let mockShouldAuthorize = true;

vi.mock("@platform/auth", () => ({
  requirePlatformAdmin:
    () =>
    async (
      c: Context<{ Variables: { platformAdmin: PlatformAdminAuthContext } }>,
      next: Next,
    ) => {
      if (!mockShouldAuthorize) {
        return c.json({ error: "FORBIDDEN", message: "Not authorized" }, 403);
      }
      c.set("platformAdmin", mockPlatformAdmin as PlatformAdminAuthContext);
      await next();
    },
}));

const { sessionHandler } = await import("./session.js");

function makeApp() {
  const app = new Hono<{
    Variables: { platformAdmin: PlatformAdminAuthContext };
  }>();
  app.get("/session", ...sessionHandler);
  return app;
}

describe("GET /platform-admin/session", () => {
  it("returns identity fields only -- never tenant/business data -- when authorized", async () => {
    mockShouldAuthorize = true;
    const res = await makeApp().request("/session");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      userId: "pa-1",
      displayName: "Ops",
      email: "ops@openwind.io",
    });
    expect(body.data).not.toHaveProperty("tenantId");
  });

  it("returns 403 when requirePlatformAdmin rejects the request", async () => {
    mockShouldAuthorize = false;
    const res = await makeApp().request("/session");
    expect(res.status).toBe(403);
  });
});
