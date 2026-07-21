import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type * as Auth from "@platform/auth";
import type { AuthContext } from "@platform/auth";
import type * as EntityEngine from "@platform/entity-engine";

// ── Mocks ─────────────────────────────────────────────────────────────────────
// requireRole is the REAL implementation (not mocked) — this test exists to
// prove the entity-types create route is admin-only, matching its
// update.ts/delete.ts siblings, after a privilege-escalation gap let "agent"
// and "user" roles create org-level entity-type schemas.

const mockCreateEntityType = vi.fn();

let currentRoles: string[] = ["admin"];

vi.mock("@platform/auth", async (importOriginal) => {
  const real = await importOriginal<typeof Auth>();
  return {
    ...real,
    requireAuth:
      () =>
      async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
        c.set("auth", {
          tenantId: "t-aaa",
          userId: "u-bbb",
          roles: currentRoles,
          email: "test@example.com",
        });
        await next();
      },
  };
});

vi.mock("@platform/db", () => ({
  db: {},
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({}),
}));

vi.mock("@platform/entity-engine", async (importOriginal) => {
  const real = await importOriginal<typeof EntityEngine>();
  return {
    ...real,
    createEntityType: (...args: unknown[]) => mockCreateEntityType(...args),
  };
});

const { createEntityTypeHandler } = await import("./create.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.post("/entity-types", ...createEntityTypeHandler);
  return app;
}

const fakeEntityType = {
  id: "00000000-0000-0000-0000-000000000001",
  tenantId: "t-aaa",
  name: "ticket",
  plural: "Tickets",
  icon: null,
  moduleId: null,
  allowCustomFields: true,
  createdAt: new Date("2026-01-01"),
};

describe("POST /entity-types", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentRoles = ["admin"];
  });

  it("returns 201 for an admin caller", async () => {
    mockCreateEntityType.mockResolvedValue(fakeEntityType);

    const res = await makeApp().request("/entity-types", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ticket", plural: "Tickets" }),
    });

    expect(res.status).toBe(201);
    expect(mockCreateEntityType).toHaveBeenCalled();
  });

  it("returns 403 for an agent caller (admin-only, matches update.ts/delete.ts)", async () => {
    currentRoles = ["agent"];

    const res = await makeApp().request("/entity-types", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ticket", plural: "Tickets" }),
    });

    expect(res.status).toBe(403);
    expect(mockCreateEntityType).not.toHaveBeenCalled();
  });

  it("returns 403 for a user/customer caller", async () => {
    currentRoles = ["user"];

    const res = await makeApp().request("/entity-types", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ticket", plural: "Tickets" }),
    });

    expect(res.status).toBe(403);
    expect(mockCreateEntityType).not.toHaveBeenCalled();
  });
});
