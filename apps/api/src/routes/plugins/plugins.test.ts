import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type * as PlatformAuth from "@platform/auth";
import type { AuthContext } from "@platform/auth";
import type * as PluginLifecycleModule from "../../services/plugin-lifecycle.js";

const mockListPluginsForTenant = vi.fn();
const mockInstallPlugin = vi.fn();
const mockUninstallPlugin = vi.fn();
const mockReportPluginRuntimeError = vi.fn();

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
    // requireRole is left as the REAL implementation so this suite actually
    // exercises the admin gate, not a bypassed mock of it.
  };
});

vi.mock("@platform/db", () => ({ db: {} }));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../services/plugin-lifecycle.js", async (importOriginal) => {
  const real = await importOriginal<typeof PluginLifecycleModule>();
  return {
    ...real,
    listPluginsForTenant: (...args: unknown[]) =>
      mockListPluginsForTenant(...args),
    installPlugin: (...args: unknown[]) => mockInstallPlugin(...args),
    uninstallPlugin: (...args: unknown[]) => mockUninstallPlugin(...args),
    reportPluginRuntimeError: (...args: unknown[]) =>
      mockReportPluginRuntimeError(...args),
  };
});

const { pluginsRouter } = await import("./index.js");
const { PluginLifecycleError } =
  await import("../../services/plugin-lifecycle.js");

function makeApp() {
  const app = new Hono();
  app.route("/plugins", pluginsRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  currentRoles = ["user"];
});

describe("GET /plugins", () => {
  it("returns the tenant-annotated catalog list for an admin caller", async () => {
    currentRoles = ["admin"];
    mockListPluginsForTenant.mockResolvedValue([
      { slug: "widget-plugin", installed: true, status: "active" },
    ]);

    const res = await makeApp().request("/plugins");

    expect(res.status).toBe(200);
    expect(mockListPluginsForTenant).toHaveBeenCalledWith("t-aaa");
    const body = await res.json();
    expect(body.data).toHaveLength(1);
  });

  // Review finding (PR #397, PrabhuVijit, N1): this route was missing the
  // requireRole("admin") guard spec task T6 requires on all plugin routes.
  it("rejects a non-admin caller (real requireRole gate)", async () => {
    currentRoles = ["user"];
    const res = await makeApp().request("/plugins");
    expect(res.status).toBe(403);
    expect(mockListPluginsForTenant).not.toHaveBeenCalled();
  });

  // Review finding (PR #397, PrabhuVijit, N2): the 500-on-throw path had no
  // test coverage.
  it("returns a generic 500 for an unexpected error", async () => {
    currentRoles = ["admin"];
    mockListPluginsForTenant.mockRejectedValueOnce(new Error("db down"));

    const res = await makeApp().request("/plugins");
    expect(res.status).toBe(500);
  });
});

describe("POST /plugins/:slug/install", () => {
  const requestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest: { id: "x" }, migrationSql: "" }),
  };

  it("rejects a non-admin caller (real requireRole gate)", async () => {
    currentRoles = ["user"];
    const res = await makeApp().request(
      "/plugins/widget_plugin/install",
      requestInit,
    );
    expect(res.status).toBe(403);
    expect(mockInstallPlugin).not.toHaveBeenCalled();
  });

  it("installs successfully for an admin caller", async () => {
    currentRoles = ["admin"];
    mockInstallPlugin.mockResolvedValueOnce({ installedPluginId: "ip-1" });

    const res = await makeApp().request(
      "/plugins/widget_plugin/install",
      requestInit,
    );

    expect(res.status).toBe(201);
    expect(mockInstallPlugin).toHaveBeenCalledWith("t-aaa", "widget_plugin", {
      manifest: { id: "x" },
      migrationSql: "",
    });
    const body = await res.json();
    expect(body.data).toEqual({
      slug: "widget_plugin",
      installedPluginId: "ip-1",
    });
  });

  it("maps ALREADY_INSTALLED to 409", async () => {
    currentRoles = ["admin"];
    mockInstallPlugin.mockRejectedValueOnce(
      new PluginLifecycleError("ALREADY_INSTALLED"),
    );

    const res = await makeApp().request(
      "/plugins/widget_plugin/install",
      requestInit,
    );
    expect(res.status).toBe(409);
  });

  it("maps MISSING_DEPENDENCY to 422 with the missing list in fields", async () => {
    currentRoles = ["admin"];
    mockInstallPlugin.mockRejectedValueOnce(
      new PluginLifecycleError("MISSING_DEPENDENCY", { missing: ["other"] }),
    );

    const res = await makeApp().request(
      "/plugins/widget_plugin/install",
      requestInit,
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toEqual({ missing: ["other"] });
  });

  it("returns a generic 500 for an unexpected error", async () => {
    currentRoles = ["admin"];
    mockInstallPlugin.mockRejectedValueOnce(new Error("boom"));

    const res = await makeApp().request(
      "/plugins/widget_plugin/install",
      requestInit,
    );
    expect(res.status).toBe(500);
  });

  it("rejects an invalid slug at the validator layer before calling the service", async () => {
    currentRoles = ["admin"];
    const res = await makeApp().request(
      "/plugins/Not-Valid!/install",
      requestInit,
    );
    expect(res.status).toBe(400);
    expect(mockInstallPlugin).not.toHaveBeenCalled();
  });
});

describe("POST /plugins/:slug/uninstall", () => {
  it("rejects a non-admin caller (real requireRole gate)", async () => {
    currentRoles = ["user"];
    const res = await makeApp().request("/plugins/widget_plugin/uninstall", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect(mockUninstallPlugin).not.toHaveBeenCalled();
  });

  it("uninstalls successfully and omits retainData from the call when not provided", async () => {
    currentRoles = ["admin"];
    mockUninstallPlugin.mockResolvedValueOnce(undefined);

    const res = await makeApp().request("/plugins/widget_plugin/uninstall", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(mockUninstallPlugin).toHaveBeenCalledWith(
      "t-aaa",
      "widget_plugin",
      {},
    );
  });

  it("passes retainData:true through when the caller sets it", async () => {
    currentRoles = ["admin"];
    mockUninstallPlugin.mockResolvedValueOnce(undefined);

    const res = await makeApp().request("/plugins/widget_plugin/uninstall", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ retainData: true }),
    });

    expect(res.status).toBe(200);
    expect(mockUninstallPlugin).toHaveBeenCalledWith("t-aaa", "widget_plugin", {
      retainData: true,
    });
  });

  it("maps NOT_INSTALLED to 404", async () => {
    currentRoles = ["admin"];
    mockUninstallPlugin.mockRejectedValueOnce(
      new PluginLifecycleError("NOT_INSTALLED"),
    );

    const res = await makeApp().request("/plugins/widget_plugin/uninstall", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /plugins/:slug/errors", () => {
  it("does not require admin — any authenticated user can report a plugin failure", async () => {
    currentRoles = ["user"];
    mockReportPluginRuntimeError.mockResolvedValueOnce(undefined);

    const res = await makeApp().request("/plugins/widget_plugin/errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "plugin blew up" }),
    });

    expect(res.status).toBe(201);
    expect(mockReportPluginRuntimeError).toHaveBeenCalledWith(
      "t-aaa",
      "widget_plugin",
      {
        slotName: undefined,
        message: "plugin blew up",
        componentStack: undefined,
      },
    );
  });

  it("maps PLUGIN_NOT_FOUND to 404", async () => {
    mockReportPluginRuntimeError.mockRejectedValueOnce(
      new PluginLifecycleError("PLUGIN_NOT_FOUND"),
    );

    const res = await makeApp().request("/plugins/nonexistent/errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects a body with no message at the validator layer", async () => {
    const res = await makeApp().request("/plugins/widget_plugin/errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(mockReportPluginRuntimeError).not.toHaveBeenCalled();
  });

  it("returns a generic 500 for an unexpected error", async () => {
    mockReportPluginRuntimeError.mockRejectedValueOnce(new Error("boom"));

    const res = await makeApp().request("/plugins/widget_plugin/errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "x" }),
    });
    expect(res.status).toBe(500);
  });
});
