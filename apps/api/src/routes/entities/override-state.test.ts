import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as WorkflowEngine from "@platform/workflow-engine";
import type * as EntityEngine from "@platform/entity-engine";

const mockOverride = vi.fn();
const mockGetEntity = vi.fn();
const mockHasAccess = vi.fn();
const mockWriteAuditEntry = vi.fn();
let mockRoles: string[] = ["admin"];
const requireRoleSpy = vi.fn();

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId: "t-aaa",
        userId: "u-admin",
        roles: mockRoles,
        email: "admin@example.com",
      });
      await next();
    },
  requireRole:
    (...roles: string[]) =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      requireRoleSpy(...roles);
      if (!roles.some((r) => c.get("auth").roles.includes(r))) {
        return c.json({ error: "FORBIDDEN" }, 403);
      }
      await next();
    },
}));

const fakeTx = { tx: true };
vi.mock("@platform/db", () => ({
  db: {},
  withTenantContext: (_t: string, fn: (tx: unknown) => unknown) => fn(fakeTx),
}));

vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => mockWriteAuditEntry(...args),
}));

vi.mock("@platform/entity-engine", async (importOriginal) => {
  const real = await importOriginal<typeof EntityEngine>();
  return { ...real, getEntity: (...args: unknown[]) => mockGetEntity(...args) };
});

vi.mock("../../lib/entity-access.js", () => ({
  hasEntityAccess: (...args: unknown[]) => mockHasAccess(...args),
}));

vi.mock("@platform/workflow-engine", async (importOriginal) => {
  const real = await importOriginal<typeof WorkflowEngine>();
  return {
    ...real,
    overrideWorkflowState: (...args: unknown[]) => mockOverride(...args),
  };
});

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { overrideStateHandler } = await import("./override-state.js");
const { WorkflowError } = await import("@platform/workflow-engine");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.post("/:id/override-state", ...overrideStateHandler);
  return app;
}

const INST = "00000000-0000-0000-0000-000000000002";
const WF = "00000000-0000-0000-0000-000000000009";
const event = {
  id: "ev-1",
  instanceId: INST,
  workflowId: WF,
  fromState: "draft",
  toState: "final",
  actorId: "u-admin",
};

const post = (body: unknown) =>
  makeApp().request(`/${INST}/override-state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /entities/:id/override-state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRoles = ["admin"];
    mockGetEntity.mockResolvedValue({ id: INST, tenantId: "t-aaa" });
    mockHasAccess.mockResolvedValue(true);
    mockOverride.mockResolvedValue(event);
    mockWriteAuditEntry.mockResolvedValue(undefined);
  });

  it("is mounted behind an admin-only role check", async () => {
    await post({ state: "final", reason: "x".repeat(12) });
    expect(requireRoleSpy).toHaveBeenCalledWith("admin");
  });

  it("returns the event and writes the admin audit entry in the same transaction", async () => {
    const res = await post({
      state: "final",
      reason: "  Customer escalated, skip review  ",
    });

    expect(res.status).toBe(200);
    expect(mockOverride).toHaveBeenCalledWith(fakeTx, "t-aaa", {
      instanceId: INST,
      state: "final",
      reason: "  Customer escalated, skip review  ",
      actorId: "u-admin",
      actorRoles: ["admin"],
    });
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      fakeTx,
      expect.objectContaining({
        tenantId: "t-aaa",
        actorId: "u-admin",
        actorType: "user",
        resourceType: "ticket",
        resourceId: INST,
        action: "workflow.state_overridden",
        beforeSnapshot: { currentState: "draft" },
        afterSnapshot: { currentState: "final" },
        metadata: { reason: "Customer escalated, skip review", workflowId: WF },
      }),
    );
  });

  it("refuses a non-admin before anything runs", async () => {
    mockRoles = ["agent"];

    const res = await post({ state: "final", reason: "x".repeat(12) });

    expect(res.status).toBe(403);
    expect(mockOverride).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("returns 404, not 403, for a record the caller cannot see", async () => {
    mockHasAccess.mockResolvedValue(false);

    const res = await post({ state: "final", reason: "x".repeat(12) });

    expect(res.status).toBe(404);
    expect(mockOverride).not.toHaveBeenCalled();
  });

  it("writes no audit entry when the override is refused", async () => {
    mockOverride.mockRejectedValue(new WorkflowError("OVERRIDE_NOT_ENABLED"));

    const res = await post({ state: "final", reason: "x".repeat(12) });

    expect(res.status).toBe(409);
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it.each([
    ["OVERRIDE_NOT_ENABLED", 409],
    ["OVERRIDE_FORBIDDEN", 403],
    ["OVERRIDE_REASON_REQUIRED", 422],
    ["OVERRIDE_NO_CHANGE", 409],
    ["WORKFLOW_STATE_NOT_FOUND", 404],
  ] as const)("maps %s to %i", async (errorCode, status) => {
    mockOverride.mockRejectedValue(new WorkflowError(errorCode));

    const res = await post({ state: "final", reason: "x".repeat(12) });

    expect(res.status).toBe(status);
    expect(((await res.json()) as { error: string }).error).toBe(errorCode);
  });

  it("fails the request, so the state change rolls back, when the audit write fails", async () => {
    mockWriteAuditEntry.mockRejectedValue(new Error("audit down"));

    const res = await post({ state: "final", reason: "x".repeat(12) });

    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it("rejects a malformed body with 400 before touching the engine", async () => {
    for (const body of [
      {},
      { state: "", reason: "x".repeat(12) },
      { state: "final" },
      { state: "final", reason: "x".repeat(2001) },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
    }
    expect(mockOverride).not.toHaveBeenCalled();
  });
});
