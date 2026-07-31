import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

// ── Hoisted mutable auth fixture ──────────────────────────────────────────────

const { mockAuth } = vi.hoisted(() => ({
  mockAuth: {
    tenantId: "t-aaa",
    userId: "u-bbb",
    roles: ["admin"] as string[],
    email: "test@example.com",
  },
}));

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", mockAuth as AuthContext);
      await next();
    },
  requireRole:
    (..._roles: string[]) =>
    async (_c: Context, next: Next) => {
      await next();
    },
  requireIntrospection: () => async (_c: Context, next: Next) => {
    await next();
  },
  hashApiKey: (key: string) => `hashed:${key}`,
}));

vi.mock("@platform/db", () => ({
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) => {
    const tx = {
      insert: () => tx,
      values: () => tx,
      returning: () =>
        Promise.resolve([
          {
            id: "key-1",
            name: "test-key",
            scopes: [],
            createdAt: new Date(),
          },
        ]),
    };
    return fn(tx);
  },
  apiKeys: {},
}));

const { createApiKeyHandler } = await import("./create.js");

// ── Test app ──────────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.post("/", ...createApiKeyHandler);
  return app;
}

function body(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ name: "my-key", ...overrides });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api-keys — scope ceiling guard (#223)", () => {
  beforeEach(() => {
    mockAuth.roles = ["admin"];
  });

  it("returns 201 when scopes match creator role exactly", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ scopes: ["admin"] }),
    });
    expect(res.status).toBe(201);
  });

  it("returns 201 when admin grants a lower-privilege scope (hierarchy check)", async () => {
    mockAuth.roles = ["admin"];
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ scopes: ["agent"] }),
    });
    expect(res.status).toBe(201);
  });

  it("returns 403 when agent attempts to grant admin scope — escalation blocked", async () => {
    mockAuth.roles = ["agent"];
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ scopes: ["admin"] }),
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 403 for an unknown scope string", async () => {
    mockAuth.roles = ["admin"];
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ scopes: ["custom_role"] }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 201 for empty scopes array", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ scopes: [] }),
    });
    expect(res.status).toBe(201);
  });

  it("returns 201 for default (no scopes field)", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body(),
    });
    expect(res.status).toBe(201);
  });

  it("returns 403 when admin requests superadmin scope — privilege escalation blocked", async () => {
    mockAuth.roles = ["admin"];
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ scopes: ["superadmin"] }),
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 403 when admin requests a mix containing superadmin", async () => {
    mockAuth.roles = ["admin"];
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ scopes: ["admin", "superadmin"] }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 201 when superadmin requests superadmin scope", async () => {
    mockAuth.roles = ["superadmin"];
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ scopes: ["superadmin"] }),
    });
    expect(res.status).toBe(201);
  });
});
