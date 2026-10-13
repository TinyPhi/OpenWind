import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as EntityEngine from "@platform/entity-engine";

const mockGetEntity = vi.fn();
const mockHasEntityAccess = vi.fn();
const mockWriteAuditEntry = vi.fn();

const mockAuth: AuthContext = {
  tenantId: "t-aaa",
  userId: "u-bbb",
  roles: ["user"],
  email: "test@example.com",
};

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", mockAuth);
      await next();
    },
}));

vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => mockWriteAuditEntry(...args),
}));

vi.mock("@platform/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const mockTx = {
  select: () => ({
    from: () => ({
      where: () => ({ limit: () => Promise.resolve([]) }),
    }),
  }),
};

vi.mock("@platform/db", () => ({
  db: {},
  entityRelations: {},
  workflows: {},
  teams: {},
  withTenantContext: (_t: unknown, fn: (tx: unknown) => unknown) => fn(mockTx),
}));

vi.mock("@platform/entity-engine", async (importOriginal) => {
  const real = await importOriginal<typeof EntityEngine>();
  return {
    ...real,
    getEntity: (...args: unknown[]) => mockGetEntity(...args),
    getParentId: vi.fn().mockResolvedValue(null),
    countActiveChildren: vi.fn().mockResolvedValue(0),
  };
});

vi.mock("../../lib/entity-access.js", () => ({
  hasEntityAccess: (...args: unknown[]) => mockHasEntityAccess(...args),
}));

const { getEntityHandler } = await import("./get.js");
const { EntityError } = await import("@platform/entity-engine");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/:id", ...getEntityHandler);
  return app;
}

const INST_ID = "00000000-0000-0000-0000-000000000002";
const fakeInstance = {
  id: INST_ID,
  tenantId: "t-aaa",
  workflowId: null,
  fields: { subject: "hello" },
};

describe("GET /entities/:id — denial audit (#640)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteAuditEntry.mockResolvedValue(undefined);
  });

  it("returns 404 and writes one ticket.view_denied for an existing record without access", async () => {
    mockGetEntity.mockResolvedValue(fakeInstance);
    mockHasEntityAccess.mockResolvedValue(false);

    const res = await makeApp().request(`/${INST_ID}`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "NOT_FOUND",
      message: "Record not found",
    });
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditEntry.mock.calls[0][1]).toMatchObject({
      tenantId: "t-aaa",
      actorId: "u-bbb",
      actorType: "user",
      resourceType: "ticket",
      resourceId: INST_ID,
      action: "ticket.view_denied",
    });
  });

  it("writes no denial audit for a genuinely missing record", async () => {
    mockGetEntity.mockRejectedValue(new EntityError("ENTITY_NOT_FOUND"));

    const res = await makeApp().request(`/${INST_ID}`);

    expect(res.status).toBe(404);
    expect(mockHasEntityAccess).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("returns 200 with no denial audit for an allowed read", async () => {
    mockGetEntity.mockResolvedValue(fakeInstance);
    mockHasEntityAccess.mockResolvedValue(true);

    const res = await makeApp().request(`/${INST_ID}`);

    expect(res.status).toBe(200);
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("still returns the same 404 body when the audit write fails (best-effort)", async () => {
    mockGetEntity.mockResolvedValue(fakeInstance);
    mockHasEntityAccess.mockResolvedValue(false);
    mockWriteAuditEntry.mockRejectedValue(new Error("audit down"));

    const res = await makeApp().request(`/${INST_ID}`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "NOT_FOUND",
      message: "Record not found",
    });
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
  });
});
