import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { PlatformAdminAuthContext } from "@platform/auth";
import type * as PlatformDb from "@platform/db";

vi.mock("@platform/auth", () => ({
  requirePlatformAdmin:
    () =>
    async (
      c: Context<{ Variables: { platformAdmin: PlatformAdminAuthContext } }>,
      next: Next,
    ) => {
      c.set("platformAdmin", {
        userId: "pa-1",
        roles: ["platform_admin"],
        email: "ops@openwind.io",
        displayName: "Ops",
      });
      await next();
    },
}));

const mockSetBranding = vi.fn();
vi.mock("@platform/db", async (importOriginal) => {
  const actual = await importOriginal<typeof PlatformDb>();
  return {
    ...actual,
    setSandboxBranding: (...args: unknown[]) => mockSetBranding(...args),
  };
});

const { sandboxBrandingHandler } = await import("./sandbox-branding.js");

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const LOGO = `data:image/png;base64,${PNG.toString("base64")}`;

function patch(body: unknown, id = TENANT_ID): Promise<Response> {
  const app = new Hono<{
    Variables: { platformAdmin: PlatformAdminAuthContext };
  }>();
  app.patch("/sandboxes/:tenantId/branding", ...sandboxBrandingHandler);
  return Promise.resolve(
    app.request(`/sandboxes/${id}/branding`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const ROW = {
  id: TENANT_ID,
  name: "Acme Demo",
  isSandbox: true,
  trialEndsAt: null,
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  logo: LOGO,
  loginKey: "3f9a1c7e2b4d8a60",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PATCH /sandboxes/:tenantId/branding", () => {
  it("sets the name and logo as the signed-in admin and returns the sandbox view", async () => {
    mockSetBranding.mockResolvedValue(ROW);

    const res = await patch({ name: "Acme Demo", logo: LOGO });

    expect(res.status).toBe(200);
    expect(mockSetBranding).toHaveBeenCalledWith(
      TENANT_ID,
      { name: "Acme Demo", logo: LOGO },
      "pa-1",
    );
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      id: TENANT_ID,
      name: "Acme Demo",
      logo: LOGO,
    });
  });

  it("trims the name before it reaches the database", async () => {
    mockSetBranding.mockResolvedValue(ROW);

    await patch({ name: "  Acme  " });

    expect(mockSetBranding).toHaveBeenCalledWith(
      TENANT_ID,
      { name: "Acme" },
      "pa-1",
    );
  });

  it("passes logo null through so the logo is cleared", async () => {
    mockSetBranding.mockResolvedValue(ROW);

    const res = await patch({ logo: null });

    expect(res.status).toBe(200);
    expect(mockSetBranding).toHaveBeenCalledWith(
      TENANT_ID,
      { logo: null },
      "pa-1",
    );
  });

  it("returns 404 when no active sandbox matched", async () => {
    mockSetBranding.mockResolvedValue(null);

    const res = await patch({ name: "Nope" });

    expect(res.status).toBe(404);
  });

  it.each([
    ["an empty body", {}],
    ["a blank name", { name: "   " }],
    ["a name over 100 characters", { name: "x".repeat(101) }],
    ["an SVG logo", { logo: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }],
    [
      "a logo whose bytes do not match its type",
      { logo: `data:image/jpeg;base64,${PNG.toString("base64")}` },
    ],
    ["an unknown field", { name: "Acme", isSandbox: false }],
  ])("returns 400 for %s and changes nothing", async (_label, body) => {
    const res = await patch(body);

    expect(res.status).toBe(400);
    expect(mockSetBranding).not.toHaveBeenCalled();
  });

  it("returns 400 for a tenant id that is not a uuid", async () => {
    const res = await patch({ name: "Acme" }, "not-a-uuid");

    expect(res.status).toBe(400);
    expect(mockSetBranding).not.toHaveBeenCalled();
  });
});
