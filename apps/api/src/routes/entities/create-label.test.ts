import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as EntityEngine from "@platform/entity-engine";

const mockAuth = {
  tenantId: "t-aaa",
  userId: "u-bbb",
  roles: ["agent"] as string[],
  email: "test@example.com",
};

const mockGetEntity = vi.fn().mockResolvedValue({
  id: "irrelevant",
  createdBy: null,
  assignedTo: null,
  fields: {},
});

const mockWriteAuditEntry = vi.fn();

let labelRefValid = true;
let insertShouldConflict = false;

const mockInsertedRow = {
  ticketInstanceId: "00000000-0000-0000-0000-000000000002",
  labelId: "00000000-0000-0000-0000-000000000050",
  tenantId: "t-aaa",
  assignedBy: "u-bbb",
  assignedAt: new Date(),
};

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", mockAuth as AuthContext);
      await next();
    },
  requireRole:
    (...allowedRoles: string[]) =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      const auth = c.get("auth");
      if (!auth?.roles.some((r) => allowedRoles.includes(r))) {
        return c.json({ error: "FORBIDDEN" }, 403);
      }
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
      insert: () => tx,
      values: () => tx,
      returning: () => {
        if (insertShouldConflict) {
          const err = new Error("duplicate key");
          (err as unknown as { cause: { code: string } }).cause = {
            code: "23505",
          };
          throw err;
        }
        return Promise.resolve([mockInsertedRow]);
      },
    };
    return fn(tx);
  },
}));

vi.mock("@platform/entity-engine", async (importOriginal) => {
  const real = await importOriginal<typeof EntityEngine>();
  return {
    ...real,
    getEntity: (...args: unknown[]) => mockGetEntity(...args),
  };
});

vi.mock("@platform/teams", () => ({
  lookupValidIdsInTable: () => async () =>
    labelRefValid
      ? new Set(["00000000-0000-0000-0000-000000000050"])
      : new Set(),
  validateCrossTenantRefs: async (
    refs: { fieldName: string; refId: string }[],
    lookup: (ids: string[]) => Promise<Set<string>>,
  ) => {
    const validIds = await lookup(refs.map((r) => r.refId));
    return refs
      .filter((r) => !validIds.has(r.refId))
      .map((r) => ({
        field: r.fieldName,
        code: "INVALID_REFERENCE",
        message: "Referenced resource does not exist or is not accessible",
        meta: { refId: r.refId },
      }));
  },
}));

vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => {
    mockWriteAuditEntry(...args);
    return Promise.resolve();
  },
}));

vi.mock("../../lib/assert-record-workflow-access.js", () => ({
  assertRecordWorkflowAccess: vi.fn().mockResolvedValue(undefined),
}));

const { createLabelHandler } = await import("./create-label.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.post("/:id/labels", ...createLabelHandler);
  return app;
}

const INST_ID = "00000000-0000-0000-0000-000000000002";
const LABEL_ID = "00000000-0000-0000-0000-000000000050";

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.roles = ["agent"];
  labelRefValid = true;
  insertShouldConflict = false;
  mockGetEntity.mockResolvedValue({
    id: INST_ID,
    createdBy: null,
    assignedTo: null,
    fields: {},
  });
});

describe("POST /entities/:id/labels", () => {
  it("returns 201 and assigns the label when labelId is valid", async () => {
    const res = await makeApp().request(`/${INST_ID}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labelId: LABEL_ID }),
    });
    expect(res.status).toBe(201);
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "label.assigned" }),
    );
  });

  it("returns 422 when labelId does not resolve within the tenant (cross-tenant or missing)", async () => {
    labelRefValid = false;
    const res = await makeApp().request(`/${INST_ID}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labelId: LABEL_ID }),
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 409 when the label is already assigned to this ticket", async () => {
    insertShouldConflict = true;
    const res = await makeApp().request(`/${INST_ID}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labelId: LABEL_ID }),
    });
    expect(res.status).toBe(409);
  });

  it("returns 404 when the ticket does not exist", async () => {
    const { EntityError } = await import("@platform/entity-engine");
    mockGetEntity.mockRejectedValueOnce(
      new EntityError("ENTITY_NOT_FOUND", { instanceId: INST_ID }),
    );
    const res = await makeApp().request(`/${INST_ID}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labelId: LABEL_ID }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 for a role outside admin/agent/user", async () => {
    mockAuth.roles = ["nobody"];
    const res = await makeApp().request(`/${INST_ID}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labelId: LABEL_ID }),
    });
    expect(res.status).toBe(403);
  });
});
