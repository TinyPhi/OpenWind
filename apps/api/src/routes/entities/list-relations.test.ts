import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as EntityEngine from "@platform/entity-engine";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockListRelations = vi.fn();
// Read-access gate check (list-relations.ts had none prior to this fix, the
// exact same IDOR class as list-children.ts's C-2 finding) — resolves to an
// instance the "agent" role auth context always passes.
const mockGetEntityForAccess = vi.fn().mockResolvedValue({
  id: "irrelevant",
  createdBy: null,
  assignedTo: null,
  fields: {},
});

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
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn({}),
}));

vi.mock("@platform/entity-engine", async (importOriginal) => {
  const real = await importOriginal<typeof EntityEngine>();
  return {
    ...real,
    getEntity: (...args: unknown[]) => mockGetEntityForAccess(...args),
    listRelations: (...args: unknown[]) => mockListRelations(...args),
  };
});

const { listRelationsHandler } = await import("./list-relations.js");

// ── Test app ──────────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/:id/relations", ...listRelationsHandler);
  return app;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const INST_ID = "00000000-0000-0000-0000-000000000002";

const fakeRelation = {
  id: "00000000-0000-0000-0000-000000000010",
  fromInstanceId: INST_ID,
  toInstanceId: "00000000-0000-0000-0000-000000000099",
  relationType: "child_of",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /entities/:id/relations", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with the relation page", async () => {
    mockListRelations.mockResolvedValue({
      data: [fakeRelation],
      nextCursor: null,
    });

    const res = await makeApp().request(`/${INST_ID}/relations`);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].relationType).toBe("child_of");
    expect(mockListRelations).toHaveBeenCalledWith(
      {},
      "t-aaa",
      INST_ID,
      expect.objectContaining({ limit: 50 }),
    );
  });

  it("returns 404 without calling listRelations when the caller lacks read access to the record", async () => {
    const { EntityError } = await import("@platform/entity-engine");
    mockGetEntityForAccess.mockRejectedValueOnce(
      new EntityError("ENTITY_NOT_FOUND", { instanceId: INST_ID }),
    );

    const res = await makeApp().request(`/${INST_ID}/relations`);

    expect(res.status).toBe(404);
    expect(mockListRelations).not.toHaveBeenCalled();
  });
});
