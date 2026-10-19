import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

// ── Mocks ─────────────────────────────────────────────────────────────────────

let mockRoles: string[] = ["admin"];
let mockUserId = "user-bbb";
const mockUpdateWorkflow = vi.fn();
const mockListOrgUsers = vi.fn();

vi.mock("@platform/auth", () => ({
  requireAuth:
    (opts?: { tenantId?: string; roles?: string[] }) =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId: opts?.tenantId ?? "tenant-aaa",
        userId: mockUserId,
        orgId: "org-ccc",
        roles: opts?.roles ?? mockRoles,
        email: "test@example.com",
      });
      await next();
    },
  requireRole: () => async (_c: Context, next: Next) => {
    await next();
  },
}));

let mockBeforeRow: {
  assignedTo: string[] | null;
  allowStateOverride?: boolean;
} | null = {
  assignedTo: [],
};
const mockPreRead = vi.fn();
const mockTx = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => {
          mockPreRead();
          return Promise.resolve(mockBeforeRow ? [mockBeforeRow] : []);
        },
      }),
    }),
  }),
};

vi.mock("@platform/db", () => ({
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn(mockTx),
  workflows: {
    id: "workflows.id",
    tenantId: "workflows.tenantId",
    assignedTo: "workflows.assignedTo",
    allowStateOverride: "workflows.allowStateOverride",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (a: unknown, b: unknown) => ({ a, b }),
}));

const mockWriteAuditEntry = vi.fn();
vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => mockWriteAuditEntry(...args),
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
    mockBeforeRow = { assignedTo: [] };
    mockRoles = ["admin"];
    mockWriteAuditEntry.mockResolvedValue(undefined);
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

  describe("workflow admin audit (#640)", () => {
    const patch = (body: unknown) =>
      makeApp().request("/wf-001", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    it("writes one workflow.admins_updated entry with before/after when assignedTo changes", async () => {
      mockBeforeRow = { assignedTo: ["user-old"] };
      mockUpdateWorkflow.mockResolvedValue({
        id: "wf-001",
        assignedTo: ["user-bbb"],
      });

      const res = await patch({ assignedTo: ["user-bbb"] });

      expect(res.status).toBe(200);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      expect(mockWriteAuditEntry).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          tenantId: "tenant-aaa",
          actorId: "user-bbb",
          resourceType: "workflow",
          resourceId: "wf-001",
          action: "workflow.admins_updated",
          beforeSnapshot: { assignedTo: ["user-old"] },
          afterSnapshot: { assignedTo: ["user-bbb"] },
        }),
      );
    });

    it("writes no entry when the same members are submitted in a different order", async () => {
      mockListOrgUsers.mockResolvedValue([
        {
          userId: "user-a",
          email: "a@x.com",
          displayName: "A",
          loginName: "a",
        },
        {
          userId: "user-b",
          email: "b@x.com",
          displayName: "B",
          loginName: "b",
        },
      ]);
      mockBeforeRow = { assignedTo: ["user-a", "user-b"] };
      mockUpdateWorkflow.mockResolvedValue({
        id: "wf-001",
        assignedTo: ["user-b", "user-a"],
      });

      const res = await patch({ assignedTo: ["user-b", "user-a"] });

      expect(res.status).toBe(200);
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });

    it("writes no entry and does not pre-read when assignedTo is omitted", async () => {
      const res = await patch({ isActive: false });

      expect(res.status).toBe(200);
      expect(mockPreRead).not.toHaveBeenCalled();
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });

    it("fails the request when the audit write rejects", async () => {
      mockBeforeRow = { assignedTo: [] };
      mockUpdateWorkflow.mockResolvedValue({
        id: "wf-001",
        assignedTo: ["user-bbb"],
      });
      mockWriteAuditEntry.mockRejectedValue(new Error("audit down"));

      const res = await patch({ assignedTo: ["user-bbb"] });

      expect(res.status).toBe(500);
    });
  });
});

describe("PATCH /workflows/:id allowStateOverride (guarded override switch)", () => {
  const patch = (body: unknown) =>
    makeApp().request("/wf-001", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mockRoles = ["admin"];
    mockUserId = "user-bbb";
    mockBeforeRow = { assignedTo: [], allowStateOverride: false };
    mockUpdateWorkflow.mockResolvedValue({
      id: "wf-001",
      assignedTo: [],
      allowStateOverride: true,
    });
    mockWriteAuditEntry.mockResolvedValue(undefined);
  });

  it("lets a tenant admin turn it on and records the change", async () => {
    const res = await patch({ allowStateOverride: true });

    expect(res.status).toBe(200);
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        tenantId: "tenant-aaa",
        actorId: "user-bbb",
        resourceType: "workflow",
        resourceId: "wf-001",
        action: "workflow.override_policy_updated",
        beforeSnapshot: { allowStateOverride: false },
        afterSnapshot: { allowStateOverride: true },
      }),
    );
  });

  it("refuses anyone who is not a tenant admin, before touching the workflow", async () => {
    mockRoles = ["agent"];

    const res = await patch({ allowStateOverride: true });

    expect(res.status).toBe(403);
    expect(mockUpdateWorkflow).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("refuses an admin-scoped API key: it may not arm overrides for someone else to use", async () => {
    mockUserId = "apikey:5d1c7e0a-0000-4000-8000-000000000001";

    const res = await patch({ allowStateOverride: true });

    expect(res.status).toBe(403);
    expect(mockUpdateWorkflow).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("writes no entry when the switch is resubmitted unchanged", async () => {
    mockBeforeRow = { assignedTo: [], allowStateOverride: true };

    const res = await patch({ allowStateOverride: true });

    expect(res.status).toBe(200);
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("does not require admin for other workflow settings", async () => {
    mockRoles = ["agent"];
    mockUpdateWorkflow.mockResolvedValue({ id: "wf-001", isActive: false });

    const res = await patch({ isActive: false });

    expect(res.status).toBe(200);
  });
});
