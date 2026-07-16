import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AuthContext } from "@platform/auth";

// ── Mock @platform/db ─────────────────────────────────────────────────────────

vi.mock("@platform/db", () => ({
  db: {},
  withTenantContext: vi.fn((_tenantId, fn) => fn({})),
}));

// ── Mock @platform/entity-engine ─────────────────────────────────────────────

const mockCreateChildRelation = vi.fn();
const mockListChildInstances = vi.fn();
const mockMoveChildRelation = vi.fn();
const mockGetParentId = vi.fn();
const mockUpdateEntity = vi.fn();
const mockArchiveEntity = vi.fn();
const mockRestoreEntity = vi.fn();
const mockGetEntity = vi.fn();
const mockCountActiveChildren = vi.fn();

vi.mock("@platform/entity-engine", () => ({
  createChildRelation: (...args: unknown[]) => mockCreateChildRelation(...args),
  listChildInstances: (...args: unknown[]) => mockListChildInstances(...args),
  moveChildRelation: (...args: unknown[]) => mockMoveChildRelation(...args),
  getParentId: (...args: unknown[]) => mockGetParentId(...args),
  updateEntity: (...args: unknown[]) => mockUpdateEntity(...args),
  archiveEntity: (...args: unknown[]) => mockArchiveEntity(...args),
  restoreEntity: (...args: unknown[]) => mockRestoreEntity(...args),
  getEntity: (...args: unknown[]) => mockGetEntity(...args),
  countActiveChildren: (...args: unknown[]) => mockCountActiveChildren(...args),
  DEFAULT_PAGE_SIZE: 50,
  MAX_PAGE_SIZE: 100,
}));

// ── Mock @platform/auth ───────────────────────────────────────────────────────

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (
      c: { get: (k: string) => unknown; set: (k: string, v: unknown) => void },
      next: () => Promise<void>,
    ) => {
      c.set("auth", {
        tenantId: "tenant-aaa",
        userId: "user-bbb",
        roles: ["agent"],
      } as AuthContext);
      return next();
    },
  requireRole:
    (..._roles: string[]) =>
    async (_c: unknown, next: () => Promise<void>) =>
      next(),
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Import handlers after mocks ───────────────────────────────────────────────

const { createChildHandler } = await import("./create-child.js");
const { listChildrenHandler } = await import("./list-children.js");
const { moveParentHandler } = await import("./move-parent.js");
const { setChildStatusHandler } = await import("./set-child-status.js");
const { archiveEntityHandler } = await import("./archive.js");
const { restoreEntityHandler } = await import("./restore.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

type Vars = { Variables: { auth: AuthContext } };

function buildApp(
  method: "get" | "post" | "patch" | "delete",
  path: string,
  ...handlers: Parameters<typeof createChildHandler>
) {
  const app = new Hono<Vars>();
  app[method](path, ...handlers);
  return app;
}

const TENANT = "tenant-aaa";
const PARENT_ID = "00000000-0000-0000-0000-000000000001";
const CHILD_ID = "00000000-0000-0000-0000-000000000002";
const ENTITY_TYPE_ID = "00000000-0000-0000-0000-000000000010";

const fakeChild = {
  id: CHILD_ID,
  entityTypeId: ENTITY_TYPE_ID,
  tenantId: TENANT,
  workflowId: null,
  currentState: "open",
  fields: { child_status: "open" },
  createdBy: "user-bbb",
  assignedTo: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

beforeEach(() => vi.clearAllMocks());

// ── POST /:id/children ────────────────────────────────────────────────────────

describe("POST /:id/children", () => {
  const app = buildApp("post", "/:id/children", ...createChildHandler);

  it("returns 201 with created child on success", async () => {
    mockCreateChildRelation.mockResolvedValue({
      instance: fakeChild,
      relations: [],
    });

    const res = await app.request(`/${PARENT_ID}/children`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entityTypeId: ENTITY_TYPE_ID,
        fields: { title: "Sub" },
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { instance: typeof fakeChild } };
    expect(body.data.instance.id).toBe(CHILD_ID);
  });

  it("returns 422 when entity-engine throws CHILDREN_DISABLED", async () => {
    mockCreateChildRelation.mockRejectedValue(
      Object.assign(new Error("disabled"), {
        name: "EntityError",
        code: "CHILDREN_DISABLED",
      }),
    );

    const res = await app.request(`/${PARENT_ID}/children`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityTypeId: ENTITY_TYPE_ID }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when entityTypeId is not a UUID", async () => {
    const res = await app.request(`/${PARENT_ID}/children`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityTypeId: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
  });
});

// ── GET /:id/children ─────────────────────────────────────────────────────────

describe("GET /:id/children", () => {
  const app = buildApp("get", "/:id/children", ...listChildrenHandler);

  it("returns 200 with paginated children", async () => {
    mockListChildInstances.mockResolvedValue({
      data: [fakeChild],
      nextCursor: null,
    });

    const res = await app.request(`/${PARENT_ID}/children`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: (typeof fakeChild)[];
      nextCursor: null;
    };
    expect(body.data).toHaveLength(1);
    expect(body.nextCursor).toBeNull();
  });

  it("passes cursor and limit to engine", async () => {
    mockListChildInstances.mockResolvedValue({ data: [], nextCursor: null });

    await app.request(`/${PARENT_ID}/children?cursor=abc&limit=5`);

    expect(mockListChildInstances).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      PARENT_ID,
      { cursor: "abc", limit: 5 },
    );
  });
});

// ── PATCH /:id/parent ─────────────────────────────────────────────────────────

describe("PATCH /:id/parent", () => {
  const app = buildApp("patch", "/:id/parent", ...moveParentHandler);

  it("returns 200 with empty relations on detach (parentId null)", async () => {
    mockMoveChildRelation.mockResolvedValue([]);

    const res = await app.request(`/${CHILD_ID}/parent`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentId: null }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(0);
  });

  it("returns 422 when cycle detected", async () => {
    mockMoveChildRelation.mockRejectedValue(
      Object.assign(new Error("cycle"), {
        name: "EntityError",
        code: "CHILD_CYCLE_DETECTED",
      }),
    );

    const res = await app.request(`/${CHILD_ID}/parent`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parentId: "00000000-0000-0000-0000-000000000099",
      }),
    });
    expect(res.status).toBe(422);
  });
});

// ── PATCH /:id/child-status ───────────────────────────────────────────────────

describe("PATCH /:id/child-status", () => {
  const app = buildApp("patch", "/:id/child-status", ...setChildStatusHandler);

  it("returns 200 with updated instance when ticket is a child", async () => {
    mockGetParentId.mockResolvedValue(PARENT_ID);
    mockUpdateEntity.mockResolvedValue({
      ...fakeChild,
      currentState: "closed",
      fields: { child_status: "closed" },
    });

    const res = await app.request(`/${CHILD_ID}/child-status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { currentState: string } };
    expect(body.data.currentState).toBe("closed");
  });

  it("returns 422 when ticket is not a child (no parentId)", async () => {
    mockGetParentId.mockResolvedValue(null);

    const res = await app.request(`/${CHILD_ID}/child-status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });
    expect(res.status).toBe(422);
  });
});

// ── POST /:id/archive ─────────────────────────────────────────────────────────

describe("POST /:id/archive", () => {
  const app = buildApp("post", "/:id/archive", ...archiveEntityHandler);

  it("returns 200 with requiresConfirm when ticket has children", async () => {
    mockArchiveEntity.mockResolvedValue({
      requiresConfirm: true,
      childCount: 3,
    });

    const res = await app.request(`/${PARENT_ID}/archive`, { method: "POST" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { requiresConfirm: boolean; childCount: number };
    };
    expect(body.data.requiresConfirm).toBe(true);
    expect(body.data.childCount).toBe(3);
  });

  it("passes confirm=true to engine when query param set", async () => {
    mockArchiveEntity.mockResolvedValue({ archived: true, count: 4 });

    const res = await app.request(`/${PARENT_ID}/archive?confirm=true`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(mockArchiveEntity).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      PARENT_ID,
      true,
    );
  });

  it("returns 404 when ticket not found", async () => {
    mockArchiveEntity.mockRejectedValue(
      Object.assign(new Error("not found"), {
        name: "EntityError",
        code: "ENTITY_NOT_FOUND",
      }),
    );

    const res = await app.request(`/${PARENT_ID}/archive`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// ── POST /:id/restore ─────────────────────────────────────────────────────────

describe("POST /:id/restore", () => {
  const app = buildApp("post", "/:id/restore", ...restoreEntityHandler);

  it("returns 200 with restore count on success", async () => {
    mockRestoreEntity.mockResolvedValue({ restored: true, count: 3 });

    const res = await app.request(`/${PARENT_ID}/restore`, { method: "POST" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { restored: boolean; count: number };
    };
    expect(body.data.restored).toBe(true);
    expect(body.data.count).toBe(3);
  });

  it("returns 404 when ticket is not archived", async () => {
    mockRestoreEntity.mockRejectedValue(
      Object.assign(new Error("not found"), {
        name: "EntityError",
        code: "ENTITY_NOT_FOUND",
      }),
    );

    const res = await app.request(`/${PARENT_ID}/restore`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
