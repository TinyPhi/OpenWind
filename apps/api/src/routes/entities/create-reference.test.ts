import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as EntityEngine from "@platform/entity-engine";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockCreateReferenceLink = vi.fn();
const mockGetEntity = vi.fn();
const mockHasEntityAccess = vi.fn();

let authOverride: AuthContext = {
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
    createReferenceLink: (...args: unknown[]) =>
      mockCreateReferenceLink(...args),
  };
});

const { createReferenceHandler } = await import("./create-reference.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.post("/:id/references", ...createReferenceHandler);
  return app;
}

const FROM_ID = "00000000-0000-0000-0000-000000000001";
const TO_ID = "00000000-0000-0000-0000-000000000002";

const fakeInstance = {
  id: FROM_ID,
  createdBy: null,
  assignedTo: null,
  fields: {},
  workflowId: "wf-1",
};

describe("POST /entities/:id/references", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authOverride = {
      tenantId: "t-aaa",
      userId: "u-bbb",
      roles: ["user"],
      email: "test@example.com",
    };
  });

  it("creates the link when the caller has access to both instances", async () => {
    mockGetEntity.mockResolvedValue(fakeInstance);
    mockHasEntityAccess.mockResolvedValue(true);
    mockCreateReferenceLink.mockResolvedValue({
      relations: [
        { id: "r1", relationType: "references" },
        { id: "r2", relationType: "referenced_by" },
      ],
    });

    const res = await makeApp().request(`/${FROM_ID}/references`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toInstanceId: TO_ID }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data).toHaveLength(2);
    expect(mockCreateReferenceLink).toHaveBeenCalledWith({}, "t-aaa", {
      fromInstanceId: FROM_ID,
      toInstanceId: TO_ID,
    });
  });

  it("returns 404 when the caller lacks access to the source instance, without creating a link", async () => {
    mockGetEntity.mockResolvedValue(fakeInstance);
    mockHasEntityAccess.mockResolvedValueOnce(false);

    const res = await makeApp().request(`/${FROM_ID}/references`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toInstanceId: TO_ID }),
    });

    expect(res.status).toBe(404);
    expect(mockCreateReferenceLink).not.toHaveBeenCalled();
  });

  it("returns 404 when the caller lacks access to the target instance, without creating a link", async () => {
    mockGetEntity.mockResolvedValue(fakeInstance);
    mockHasEntityAccess
      .mockResolvedValueOnce(true) // source ok
      .mockResolvedValueOnce(false); // target denied

    const res = await makeApp().request(`/${FROM_ID}/references`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toInstanceId: TO_ID }),
    });

    expect(res.status).toBe(404);
    expect(mockCreateReferenceLink).not.toHaveBeenCalled();
  });

  it("returns 404 (not 403) when the target instance does not exist / belongs to another tenant", async () => {
    const { EntityError } = await import("@platform/entity-engine");
    mockGetEntity
      .mockResolvedValueOnce(fakeInstance)
      .mockRejectedValueOnce(
        new EntityError("ENTITY_NOT_FOUND", { instanceId: TO_ID }),
      );

    const res = await makeApp().request(`/${FROM_ID}/references`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toInstanceId: TO_ID }),
    });

    expect(res.status).toBe(404);
    expect(mockCreateReferenceLink).not.toHaveBeenCalled();
  });

  it("surfaces RELATION_SELF_LINK as a 422 via the shared error handler", async () => {
    const { EntityError } = await import("@platform/entity-engine");
    mockGetEntity.mockResolvedValue(fakeInstance);
    mockHasEntityAccess.mockResolvedValue(true);
    mockCreateReferenceLink.mockRejectedValue(
      new EntityError("RELATION_SELF_LINK", { instanceId: FROM_ID }),
    );

    const res = await makeApp().request(`/${FROM_ID}/references`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toInstanceId: FROM_ID }),
    });

    expect(res.status).toBe(422);
  });

  it("surfaces RELATION_ALREADY_EXISTS as a 409 via the shared error handler", async () => {
    const { EntityError } = await import("@platform/entity-engine");
    mockGetEntity.mockResolvedValue(fakeInstance);
    mockHasEntityAccess.mockResolvedValue(true);
    mockCreateReferenceLink.mockRejectedValue(
      new EntityError("RELATION_ALREADY_EXISTS", {
        fromInstanceId: FROM_ID,
        toInstanceId: TO_ID,
      }),
    );

    const res = await makeApp().request(`/${FROM_ID}/references`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toInstanceId: TO_ID }),
    });

    expect(res.status).toBe(409);
  });
});
