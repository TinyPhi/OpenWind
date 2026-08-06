import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as EntityEngine from "@platform/entity-engine";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockListEntities = vi.fn();
const mockGetWorkflowByEntityTypeId = vi.fn();
const mockIsWorkflowAdmin = vi.fn();

// Mutable so individual tests can switch the caller's role/id without
// re-hoisting vi.mock — requireAuth reads currentAuth at request time.
let currentAuth: AuthContext = {
  tenantId: "t-aaa",
  userId: "u-bbb",
  roles: ["agent"],
  email: "test@example.com",
  displayName: "Test User",
};

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", currentAuth);
      await next();
    },
  requireRole: () => async (_c: Context, next: Next) => {
    await next();
  },
}));

vi.mock("@platform/db", () => ({
  db: {},
  withTenantContext: (tenantId, fn) => fn({}),
}));

vi.mock("@platform/entity-engine", async (importOriginal) => {
  const real = await importOriginal<typeof EntityEngine>();
  return {
    ...real,
    listEntities: (...args: unknown[]) => mockListEntities(...args),
  };
});

vi.mock("@platform/workflow-engine", () => ({
  getWorkflowByEntityTypeId: (...args: unknown[]) =>
    mockGetWorkflowByEntityTypeId(...args),
  isWorkflowAdmin: (...args: unknown[]) => mockIsWorkflowAdmin(...args),
}));

const { listEntitiesHandler } = await import("./list.js");

// ── Test app ──────────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/", ...listEntitiesHandler);
  return app;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TYPE_ID = "00000000-0000-0000-0000-000000000001";

function makeInstance(id: string) {
  return {
    id,
    entityTypeId: TYPE_ID,
    tenantId: "t-aaa",
    workflowId: null,
    currentState: "open",
    fields: {},
    createdBy: null,
    assignedTo: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /entities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentAuth = {
      tenantId: "t-aaa",
      userId: "u-bbb",
      roles: ["agent"],
      email: "test@example.com",
      displayName: "Test User",
    };
  });

  it("returns 200 with data array and nextCursor", async () => {
    mockListEntities.mockResolvedValue({
      data: [makeInstance("inst-1"), makeInstance("inst-2")],
      nextCursor: null,
    });

    const res = await makeApp().request(`/?entityTypeId=${TYPE_ID}`);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(2);
    expect(json.nextCursor).toBeNull();
    expect(mockListEntities).toHaveBeenCalledWith(
      {},
      "t-aaa",
      expect.objectContaining({ entityTypeId: TYPE_ID }),
    );
  });

  it("returns 400 when entityTypeId is missing", async () => {
    const res = await makeApp().request("/");

    expect(res.status).toBe(400);
    expect(mockListEntities).not.toHaveBeenCalled();
  });

  it("returns 400 when entityTypeId is not a valid UUID", async () => {
    const res = await makeApp().request("/?entityTypeId=not-a-uuid");

    expect(res.status).toBe(400);
    expect(mockListEntities).not.toHaveBeenCalled();
  });

  it("passes pagination params to the engine when provided", async () => {
    mockListEntities.mockResolvedValue({ data: [], nextCursor: null });

    await makeApp().request(
      `/?entityTypeId=${TYPE_ID}&limit=10&cursor=abc&state=open&assignedTo=00000000-0000-0000-0000-000000000099`,
    );

    expect(mockListEntities).toHaveBeenCalledWith(
      {},
      "t-aaa",
      expect.objectContaining({
        limit: 10,
        cursor: "abc",
        state: "open",
        assignedTo: "00000000-0000-0000-0000-000000000099",
      }),
    );
  });

  it("passes includeDeleted=true when the query flag is set", async () => {
    mockListEntities.mockResolvedValue({ data: [], nextCursor: null });

    await makeApp().request(`/?entityTypeId=${TYPE_ID}&includeDeleted=true`);

    expect(mockListEntities).toHaveBeenCalledWith(
      {},
      "t-aaa",
      expect.objectContaining({ includeDeleted: true }),
    );
  });

  it("propagates a non-null nextCursor when there are more pages", async () => {
    mockListEntities.mockResolvedValue({
      data: [makeInstance("inst-1")],
      nextCursor: "cursor-token-xyz",
    });

    const res = await makeApp().request(`/?entityTypeId=${TYPE_ID}`);
    const json = await res.json();

    expect(json.nextCursor).toBe("cursor-token-xyz");
  });

  it("passes fieldFilters to the engine when a valid fields JSON object is provided", async () => {
    mockListEntities.mockResolvedValue({ data: [], nextCursor: null });

    const fieldsParam = encodeURIComponent(
      JSON.stringify({ priority: "high" }),
    );
    await makeApp().request(`/?entityTypeId=${TYPE_ID}&fields=${fieldsParam}`);

    expect(mockListEntities).toHaveBeenCalledWith(
      {},
      "t-aaa",
      expect.objectContaining({ fieldFilters: { priority: "high" } }),
    );
  });

  it("returns 400 when the fields param is not valid JSON", async () => {
    const res = await makeApp().request(
      `/?entityTypeId=${TYPE_ID}&fields=not-json`,
    );

    expect(res.status).toBe(400);
    expect(mockListEntities).not.toHaveBeenCalled();
  });

  it("returns 400 when the fields param is a JSON array, not an object", async () => {
    const fieldsParam = encodeURIComponent(JSON.stringify([1, 2, 3]));
    const res = await makeApp().request(
      `/?entityTypeId=${TYPE_ID}&fields=${fieldsParam}`,
    );

    expect(res.status).toBe(400);
    expect(mockListEntities).not.toHaveBeenCalled();
  });
});

describe("GET /entities — non-privileged scoping (R5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentAuth = {
      tenantId: "t-aaa",
      userId: "u-bbb",
      roles: ["user"],
      email: "test@example.com",
      displayName: "Test User",
    };
    mockGetWorkflowByEntityTypeId.mockResolvedValue(null);
    mockIsWorkflowAdmin.mockReturnValue(false);
    mockListEntities.mockResolvedValue({ data: [], nextCursor: null });
  });

  it("passes scopeToUserId (not assignedTo) for a non-privileged caller with no assignedTo query param", async () => {
    await makeApp().request(`/?entityTypeId=${TYPE_ID}`);

    expect(mockListEntities).toHaveBeenCalledWith(
      {},
      "t-aaa",
      expect.objectContaining({
        scopeToUserId: "u-bbb",
        assignedTo: undefined,
      }),
    );
  });

  it("ignores ?assignedTo=<other-user> for a non-privileged caller — query param cannot override scope", async () => {
    await makeApp().request(
      `/?entityTypeId=${TYPE_ID}&assignedTo=some-other-user`,
    );

    expect(mockListEntities).toHaveBeenCalledWith(
      {},
      "t-aaa",
      expect.objectContaining({
        scopeToUserId: "u-bbb",
        assignedTo: undefined,
      }),
    );
  });

  it("passes assignedTo through (not scopeToUserId) for a privileged caller", async () => {
    currentAuth = { ...currentAuth, roles: ["agent"] };

    await makeApp().request(
      `/?entityTypeId=${TYPE_ID}&assignedTo=some-other-user`,
    );

    expect(mockListEntities).toHaveBeenCalledWith(
      {},
      "t-aaa",
      expect.objectContaining({
        assignedTo: "some-other-user",
        scopeToUserId: undefined,
      }),
    );
  });

  it("grants privileged (assignedTo passthrough) scoping to a workflow admin", async () => {
    mockGetWorkflowByEntityTypeId.mockResolvedValue({
      createdBy: "u-bbb",
      assignedTo: ["u-bbb"],
    });
    mockIsWorkflowAdmin.mockReturnValue(true);

    await makeApp().request(
      `/?entityTypeId=${TYPE_ID}&assignedTo=some-other-user`,
    );

    expect(mockListEntities).toHaveBeenCalledWith(
      {},
      "t-aaa",
      expect.objectContaining({
        assignedTo: "some-other-user",
        scopeToUserId: undefined,
      }),
    );
  });
});
