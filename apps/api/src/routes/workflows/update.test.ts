import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockUpdateWorkflow = vi.fn();

// makeTx returns a drizzle-like chainable tx object whose `.where()` resolves
// to `rows` directly (no `.limit()` — the assignee check validates every id
// in the assignedTo array via inArray, not a single row).
function makeTx(rows: unknown[]) {
  const tx: Record<string, unknown> = {};
  tx["select"] = () => tx;
  tx["from"] = () => tx;
  tx["where"] = () => Promise.resolve(rows);
  return tx;
}

// withTenantContext mock: first call (assignee check) uses `assigneeTx`,
// second call (updateWorkflow) returns the updateWorkflow result directly.
let assigneeTx: ReturnType<typeof makeTx>;

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
  tenantUsers: { userId: "userId", tenantId: "tenantId" },
  withTenantContext: (tenantId: string, fn: (tx: unknown) => unknown) =>
    fn(assigneeTx),
}));

vi.mock("@platform/workflow-engine", () => ({
  updateWorkflow: (...args: unknown[]) => mockUpdateWorkflow(...args),
}));

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  and: (...args: unknown[]) => ({ and: args }),
  inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
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
    assigneeTx = makeTx([{ userId: "user-bbb" }]);
    mockUpdateWorkflow.mockResolvedValue({ id: "wf-001", isActive: false });
  });

  it("uses withTenantContext when validating workflow admins — never bare db", async () => {
    const selectSpy = vi.spyOn(assigneeTx, "select" as never);
    const app = makeApp();
    await app.request("/wf-001", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedTo: ["user-bbb"] }),
    });

    // The tx object injected by withTenantContext was used — proving the handler
    // never calls bare db.select().
    expect(selectSpy).toHaveBeenCalled();
  });

  it("rejects a workflow admin id from a different tenant (user not found)", async () => {
    assigneeTx = makeTx([]); // empty result = none of the ids are in this tenant

    const app = makeApp();
    const res = await app.request("/wf-001", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedTo: ["user-other-tenant"] }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("NOT_FOUND");
    expect(mockUpdateWorkflow).not.toHaveBeenCalled();
  });

  it("rejects if only some workflow admin ids belong to this tenant", async () => {
    assigneeTx = makeTx([{ userId: "user-bbb" }]); // only one of two ids found

    const app = makeApp();
    const res = await app.request("/wf-001", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedTo: ["user-bbb", "user-other-tenant"] }),
    });

    expect(res.status).toBe(404);
    expect(mockUpdateWorkflow).not.toHaveBeenCalled();
  });

  it("allows an empty assignedTo array without running the tenant check", async () => {
    const selectSpy = vi.spyOn(assigneeTx, "select" as never);
    mockUpdateWorkflow.mockResolvedValue({ id: "wf-001", assignedTo: [] });

    const app = makeApp();
    const res = await app.request("/wf-001", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedTo: [] }),
    });

    expect(res.status).toBe(200);
    // assignee check tx was never consulted — empty array bypasses the lookup
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it("allows omitting assignedTo without running the tenant check", async () => {
    const selectSpy = vi.spyOn(assigneeTx, "select" as never);

    const app = makeApp();
    const res = await app.request("/wf-001", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    });

    expect(res.status).toBe(200);
    expect(selectSpy).not.toHaveBeenCalled();
  });
});
