import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockUpdateWorkflow = vi.fn();
const mockListOrgUsers = vi.fn();

vi.mock("@platform/auth", () => ({
  requireAuth:
    (opts?: { tenantId?: string; roles?: string[] }) =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId: opts?.tenantId ?? "tenant-aaa",
        userId: "user-bbb",
        orgId: "org-ccc",
        roles: opts?.roles ?? ["admin"],
        email: "test@example.com",
      });
      await next();
    },
  requireRole: () => async (_c: Context, next: Next) => {
    await next();
  },
}));

vi.mock("@platform/db", () => ({
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({}),
}));

vi.mock("@platform/workflow-engine", () => ({
  updateWorkflow: (...args: unknown[]) => mockUpdateWorkflow(...args),
}));

vi.mock("../../lib/zitadel-management.js", () => ({
  listOrgUsers: (...args: unknown[]) => mockListOrgUsers(...args),
}));

const mockLoggerWarn = vi.fn();
vi.mock("@platform/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args) },
}));

vi.mock("../../lib/handle-workflow-error.js", () => ({
  handleWorkflowError: (_c: unknown, err: unknown) => {
    throw err;
  },
}));

const { updateWorkflowHandler } = await import("./update.js");

// ── Test app ──────────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.patch(
    "/:id",
    ...(updateWorkflowHandler as Parameters<typeof app.patch>[1][]),
  );
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PATCH /workflows/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListOrgUsers.mockResolvedValue([
      {
        userId: "user-bbb",
        email: "b@x.com",
        displayName: "B",
        loginName: "b",
      },
    ]);
    mockUpdateWorkflow.mockResolvedValue({ id: "wf-001", isActive: false });
  });

  it("validates workflow admins against Zitadel org membership, not local login state", async () => {
    const app = makeApp();
    await app.request("/wf-001", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedTo: ["user-bbb"] }),
    });

    expect(mockListOrgUsers).toHaveBeenCalledWith("org-ccc");
  });

  it("allows assigning an org member who has never logged into this app", async () => {
    // The org member exists in Zitadel but has no tenant_users row —
    // exactly the case that used to 404 before this fix.
    mockListOrgUsers.mockResolvedValue([
      {
        userId: "never-logged-in-user",
        email: "new@x.com",
        displayName: "New Hire",
        loginName: "new",
      },
    ]);

    const app = makeApp();
    const res = await app.request("/wf-001", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedTo: ["never-logged-in-user"] }),
    });

    expect(res.status).toBe(200);
    expect(mockUpdateWorkflow).toHaveBeenCalled();
  });

  it("rejects a workflow admin id that is not a real member of this org", async () => {
    mockListOrgUsers.mockResolvedValue([]); // no org members match

    const app = makeApp();
    const res = await app.request("/wf-001", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedTo: ["not-a-real-user"] }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("NOT_FOUND");
    expect(mockUpdateWorkflow).not.toHaveBeenCalled();
  });

  it("logs a diagnostic warning when listOrgUsers returns zero users, since that could mean a Zitadel outage rather than a genuinely empty org", async () => {
    mockListOrgUsers.mockResolvedValue([]);

    const app = makeApp();
    await app.request("/wf-001", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedTo: ["not-a-real-user"] }),
    });

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-ccc", workflowId: "wf-001" }),
      expect.stringContaining("listOrgUsers returned zero users"),
    );
  });

  it("rejects if only some workflow admin ids belong to this org", async () => {
    mockListOrgUsers.mockResolvedValue([
      {
        userId: "user-bbb",
        email: "b@x.com",
        displayName: "B",
        loginName: "b",
      },
    ]);

    const app = makeApp();
    const res = await app.request("/wf-001", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedTo: ["user-bbb", "not-a-real-user"] }),
    });

    expect(res.status).toBe(404);
    expect(mockUpdateWorkflow).not.toHaveBeenCalled();
  });

  it("allows an empty assignedTo array without calling listOrgUsers", async () => {
    mockUpdateWorkflow.mockResolvedValue({ id: "wf-001", assignedTo: [] });

    const app = makeApp();
    const res = await app.request("/wf-001", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedTo: [] }),
    });

    expect(res.status).toBe(200);
    expect(mockListOrgUsers).not.toHaveBeenCalled();
  });

  it("allows omitting assignedTo without calling listOrgUsers", async () => {
    const app = makeApp();
    const res = await app.request("/wf-001", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    });

    expect(res.status).toBe(200);
    expect(mockListOrgUsers).not.toHaveBeenCalled();
  });
});
