import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type * as PlatformAuth from "@platform/auth";
import type { AuthContext } from "@platform/auth";

const mockListModules = vi.fn();
const mockSetVisibility = vi.fn();

let currentRoles = ["user"];

vi.mock("@platform/auth", async (importOriginal) => {
  const real = await importOriginal<typeof PlatformAuth>();
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
    // requireRole is left as the REAL implementation (re-exported via
    // `...real`) so this suite actually exercises the admin gate, not a
    // bypassed mock of it.
  };
});

vi.mock("@platform/db", () => ({ db: {} }));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../services/module-service.js", () => ({
  ModuleService: {
    listModules: (...args: unknown[]) => mockListModules(...args),
    setVisibility: (...args: unknown[]) => mockSetVisibility(...args),
  },
}));

const { modulesRouter } = await import("./index.js");

function makeApp() {
  const app = new Hono();
  app.route("/modules", modulesRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  currentRoles = ["user"];
});

describe("GET /modules", () => {
  it("defaults to includeHidden=false for a regular user/agent caller", async () => {
    currentRoles = ["user"];
    mockListModules.mockResolvedValue([{ slug: "helpdesk", isVisible: true }]);

    const res = await makeApp().request("/modules");

    expect(res.status).toBe(200);
    expect(mockListModules).toHaveBeenCalledWith("t-aaa", false);
  });

  it("defaults to includeHidden=false for an admin caller too — the Templates page is always filtered", async () => {
    currentRoles = ["admin"];
    mockListModules.mockResolvedValue([{ slug: "helpdesk", isVisible: true }]);

    const res = await makeApp().request("/modules");

    expect(res.status).toBe(200);
    expect(mockListModules).toHaveBeenCalledWith("t-aaa", false);
  });

  it("honors ?includeHidden=true for an admin caller — the Settings management view", async () => {
    currentRoles = ["admin"];
    mockListModules.mockResolvedValue([
      { slug: "helpdesk", isVisible: true },
      { slug: "hidden-template", isVisible: false },
    ]);

    const res = await makeApp().request("/modules?includeHidden=true");

    expect(res.status).toBe(200);
    expect(mockListModules).toHaveBeenCalledWith("t-aaa", true);
  });

  it("ignores ?includeHidden=true for a non-admin caller", async () => {
    currentRoles = ["user"];
    mockListModules.mockResolvedValue([{ slug: "helpdesk", isVisible: true }]);

    const res = await makeApp().request("/modules?includeHidden=true");

    expect(res.status).toBe(200);
    expect(mockListModules).toHaveBeenCalledWith("t-aaa", false);
  });
});

describe("PATCH /modules/:slug/visibility", () => {
  it("returns 403 for a non-admin caller (agent/user is not enough)", async () => {
    currentRoles = ["agent"];

    const res = await makeApp().request("/modules/helpdesk/visibility", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isVisible: false }),
    });

    expect(res.status).toBe(403);
    expect(mockSetVisibility).not.toHaveBeenCalled();
  });

  it("updates visibility for an admin caller", async () => {
    currentRoles = ["admin"];
    mockSetVisibility.mockResolvedValue(undefined);

    const res = await makeApp().request("/modules/helpdesk/visibility", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isVisible: false }),
    });

    expect(res.status).toBe(200);
    expect(mockSetVisibility).toHaveBeenCalledWith("helpdesk", false);
  });

  it("returns 400 when isVisible is not a boolean", async () => {
    currentRoles = ["admin"];

    const res = await makeApp().request("/modules/helpdesk/visibility", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isVisible: "nope" }),
    });

    expect(res.status).toBe(400);
    expect(mockSetVisibility).not.toHaveBeenCalled();
  });
});
