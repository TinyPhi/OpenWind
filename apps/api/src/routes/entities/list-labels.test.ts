import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as EntityEngine from "@platform/entity-engine";

const mockGetEntityForAccess = vi.fn().mockResolvedValue({
  id: "irrelevant",
  createdBy: null,
  assignedTo: null,
  fields: {},
});

const mockHasEntityAccess = vi.fn().mockResolvedValue(true);

const fakeLabelRow = {
  labelId: "00000000-0000-0000-0000-000000000050",
  name: "bug",
  color: "#e11d48",
  description: null,
  assignedBy: "u-bbb",
  assignedAt: new Date(),
};

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId: "t-aaa",
        userId: "u-bbb",
        roles: ["agent"],
        email: "test@example.com",
      });
      await next();
    },
  requireRole: () => async (_c: Context, next: Next) => {
    await next();
  },
}));

vi.mock("@platform/db", () => ({
  db: {},
  labels: { id: "id", tenantId: "tenantId", deletedAt: "deletedAt" },
  ticketLabels: {
    ticketInstanceId: "ticketInstanceId",
    labelId: "labelId",
    tenantId: "tenantId",
  },
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) => {
    const tx = {
      select: () => tx,
      from: () => tx,
      innerJoin: () => tx,
      where: () => Promise.resolve([fakeLabelRow]),
    };
    return fn(tx);
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (...args: unknown[]) => ({ op: "eq", args }),
  isNull: (...args: unknown[]) => ({ op: "isNull", args }),
}));

vi.mock("@platform/entity-engine", async (importOriginal) => {
  const real = await importOriginal<typeof EntityEngine>();
  return {
    ...real,
    getEntity: (...args: unknown[]) => mockGetEntityForAccess(...args),
  };
});

vi.mock("../../lib/entity-access.js", () => ({
  hasEntityAccess: (...args: unknown[]) => mockHasEntityAccess(...args),
}));

const { listLabelsHandler } = await import("./list-labels.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/:id/labels", ...listLabelsHandler);
  return app;
}

const INST_ID = "00000000-0000-0000-0000-000000000002";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetEntityForAccess.mockResolvedValue({
    id: INST_ID,
    createdBy: null,
    assignedTo: null,
    fields: {},
  });
  mockHasEntityAccess.mockResolvedValue(true);
});

describe("GET /entities/:id/labels", () => {
  it("returns 200 with the ticket's assigned labels", async () => {
    const res = await makeApp().request(`/${INST_ID}/labels`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].name).toBe("bug");
  });

  it("returns 404 without listing labels when the caller lacks read access to the record", async () => {
    mockHasEntityAccess.mockResolvedValue(false);
    const res = await makeApp().request(`/${INST_ID}/labels`);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the ticket does not exist (or belongs to another tenant)", async () => {
    const { EntityError } = await import("@platform/entity-engine");
    mockGetEntityForAccess.mockRejectedValueOnce(
      new EntityError("ENTITY_NOT_FOUND", { instanceId: INST_ID }),
    );
    const res = await makeApp().request(`/${INST_ID}/labels`);
    expect(res.status).toBe(404);
  });
});
