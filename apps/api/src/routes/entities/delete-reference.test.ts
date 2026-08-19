import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as EntityEngine from "@platform/entity-engine";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockDeleteReferenceLink = vi.fn();
const mockGetEntity = vi.fn();
const mockGetReferenceRelation = vi.fn();
const mockHasEntityAccess = vi.fn();

const authOverride: AuthContext = {
  tenantId: "t-aaa",
  userId: "u-bbb",
  roles: ["user"],
  email: "test@example.com",
};

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", authOverride);
      await next();
    },
}));

vi.mock("@platform/db", () => ({
  db: {},
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn({}),
}));

vi.mock("../../lib/entity-access.js", () => ({
  hasEntityAccess: (...args: unknown[]) => mockHasEntityAccess(...args),
}));

vi.mock("@platform/entity-engine", async (importOriginal) => {
  const real = await importOriginal<typeof EntityEngine>();
  return {
    ...real,
    getEntity: (...args: unknown[]) => mockGetEntity(...args),
    getReferenceRelation: (...args: unknown[]) =>
      mockGetReferenceRelation(...args),
    deleteReferenceLink: (...args: unknown[]) =>
      mockDeleteReferenceLink(...args),
  };
});

const { deleteReferenceHandler } = await import("./delete-reference.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.delete("/:id/references/:relationId", ...deleteReferenceHandler);
  return app;
}

const INST_ID = "00000000-0000-0000-0000-000000000001";
const RELATION_ID = "00000000-0000-0000-0000-000000000010";

const fakeInstance = {
  id: INST_ID,
  createdBy: null,
  assignedTo: null,
  fields: {},
  workflowId: "wf-1",
};

describe("DELETE /entities/:id/references/:relationId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("unlinks when the caller has access to the :id side and the relation belongs to it", async () => {
    mockGetEntity.mockResolvedValue(fakeInstance);
    mockHasEntityAccess.mockResolvedValue(true);
    mockGetReferenceRelation.mockResolvedValue({
      id: RELATION_ID,
      fromInstanceId: INST_ID,
      toInstanceId: "other",
      relationType: "references",
    });
    mockDeleteReferenceLink.mockResolvedValue(undefined);

    const res = await makeApp().request(
      `/${INST_ID}/references/${RELATION_ID}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(204);
    expect(mockDeleteReferenceLink).toHaveBeenCalledWith(
      {},
      "t-aaa",
      RELATION_ID,
      "u-bbb",
    );
  });

  it("returns 404 when the caller lacks access to the :id instance", async () => {
    mockGetEntity.mockResolvedValue(fakeInstance);
    mockHasEntityAccess.mockResolvedValue(false);

    const res = await makeApp().request(
      `/${INST_ID}/references/${RELATION_ID}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(404);
    expect(mockDeleteReferenceLink).not.toHaveBeenCalled();
  });

  it("returns 404 when the relation does not exist / belongs to another tenant", async () => {
    mockGetEntity.mockResolvedValue(fakeInstance);
    mockHasEntityAccess.mockResolvedValue(true);
    mockGetReferenceRelation.mockResolvedValue(null);

    const res = await makeApp().request(
      `/${INST_ID}/references/${RELATION_ID}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(404);
    expect(mockDeleteReferenceLink).not.toHaveBeenCalled();
  });

  it("returns 404 when the relation exists but does not belong to the :id instance (prevents deleting an unrelated relation by guessing its id)", async () => {
    mockGetEntity.mockResolvedValue(fakeInstance);
    mockHasEntityAccess.mockResolvedValue(true);
    mockGetReferenceRelation.mockResolvedValue({
      id: RELATION_ID,
      fromInstanceId: "some-other-instance",
      toInstanceId: "yet-another",
      relationType: "references",
    });

    const res = await makeApp().request(
      `/${INST_ID}/references/${RELATION_ID}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(404);
    expect(mockDeleteReferenceLink).not.toHaveBeenCalled();
  });
});
