import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

// ── Hoisted mutable auth fixture ──────────────────────────────────────────────

const { mockAuth } = vi.hoisted(() => ({
  mockAuth: {
    tenantId: "t-aaa",
    userId: "u-bbb",
    roles: ["user"] as string[],
    email: "test@example.com",
  },
}));

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockSelectResults: unknown[][] = [];
let selectCallIndex = 0;

function makeQ(result: unknown[]) {
  const q: Record<string, unknown> = {};
  q["from"] = () => q;
  q["where"] = () => q;
  q["limit"] = () => Promise.resolve(result);
  return q;
}

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", mockAuth as AuthContext);
      await next();
    },
}));

vi.mock("@platform/db", () => ({
  db: {},
  files: {},
  entityInstances: {},
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({ select: () => makeQ(mockSelectResults[selectCallIndex++] ?? []) }),
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ args }),
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

const mockHasEntityAccess = vi.fn();
vi.mock("../../lib/entity-access.js", () => ({
  hasEntityAccess: (...args: unknown[]) => mockHasEntityAccess(...args),
}));

const { getFileScanStatusHandler } = await import("./status.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/files/:id/status", ...getFileScanStatusHandler);
  return app;
}

const FILE_ID = "00000000-0000-0000-0000-000000000001";
const ENTITY_ID = "00000000-0000-0000-0000-000000000002";

describe("GET /files/:id/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectResults.length = 0;
    selectCallIndex = 0;
    mockAuth.roles = ["user"];
    mockAuth.userId = "u-bbb";
  });

  it("allows the uploader to check status of their unbound file (#224)", async () => {
    mockSelectResults.push([
      { id: FILE_ID, scanStatus: "clean", entityId: null, uploadedBy: "u-bbb" },
    ]);

    const res = await makeApp().request(`/files/${FILE_ID}/status`);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.scanStatus).toBe("clean");
    expect(mockHasEntityAccess).not.toHaveBeenCalled();
  });

  it("returns 404 for a non-uploader checking status of an unbound file (#224)", async () => {
    mockSelectResults.push([
      {
        id: FILE_ID,
        scanStatus: "clean",
        entityId: null,
        uploadedBy: "other-user",
      },
    ]);

    const res = await makeApp().request(`/files/${FILE_ID}/status`);

    expect(res.status).toBe(404);
    expect(mockHasEntityAccess).not.toHaveBeenCalled();
  });

  it("allows admin to check scan status of any unbound file (#224)", async () => {
    mockAuth.roles = ["admin"];
    mockAuth.userId = "admin-user";
    mockSelectResults.push([
      {
        id: FILE_ID,
        scanStatus: "pending",
        entityId: null,
        uploadedBy: "some-other-user",
      },
    ]);

    const res = await makeApp().request(`/files/${FILE_ID}/status`);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.scanStatus).toBe("pending");
    expect(mockHasEntityAccess).not.toHaveBeenCalled();
  });

  it("returns 404 for a caller with no access to the file's bound entity (IDOR fix)", async () => {
    mockSelectResults.push([
      { id: FILE_ID, scanStatus: "clean", entityId: ENTITY_ID },
    ]);
    mockSelectResults.push([
      {
        createdBy: "someone-else",
        assignedTo: null,
        fields: {},
        workflowId: null,
      },
    ]);
    mockHasEntityAccess.mockResolvedValue(false);

    const res = await makeApp().request(`/files/${FILE_ID}/status`);

    expect(res.status).toBe(404);
  });

  it("returns 200 for a caller with access to the file's bound entity", async () => {
    mockSelectResults.push([
      { id: FILE_ID, scanStatus: "clean", entityId: ENTITY_ID },
    ]);
    mockSelectResults.push([
      { createdBy: "u-bbb", assignedTo: null, fields: {}, workflowId: null },
    ]);
    mockHasEntityAccess.mockResolvedValue(true);

    const res = await makeApp().request(`/files/${FILE_ID}/status`);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.scanStatus).toBe("clean");
  });

  it("returns 404 for a missing file", async () => {
    mockSelectResults.push([]);

    const res = await makeApp().request(`/files/${FILE_ID}/status`);

    expect(res.status).toBe(404);
  });
});
