import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

// ── Mocks ─────────────────────────────────────────────────────────────────────

let mockAuth: AuthContext = {
  tenantId: "t-aaa",
  userId: "u-bbb",
  roles: ["agent"],
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

// Result queues for the instance lookup and the files lookup, discriminated
// by which columns each select() call asks for.
const mockInstanceResult: Record<string, unknown>[] = [];
const mockFilesResult: Record<string, unknown>[] = [];

vi.mock("@platform/db", () => ({
  entityInstances: {
    id: "entity_instances.id",
    tenantId: "entity_instances.tenant_id",
    createdBy: "entity_instances.created_by",
    assignedTo: "entity_instances.assigned_to",
    fields: "entity_instances.fields",
  },
  files: {
    id: "files.id",
    tenantId: "files.tenant_id",
    entityId: "files.entity_id",
    originalName: "files.original_name",
    mimeType: "files.mime_type",
    sizeBytes: "files.size_bytes",
    scanStatus: "files.scan_status",
    uploadedBy: "files.uploaded_by",
    createdAt: "files.created_at",
  },
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({
      select: vi.fn((_cols: Record<string, unknown>) => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn().mockResolvedValue(mockFilesResult),
            limit: vi.fn().mockResolvedValue(mockInstanceResult),
          })),
        })),
      })),
    }),
}));

vi.mock("drizzle-orm", () => ({
  and: (...conds: unknown[]) => ({ op: "and", conds }),
  eq: (col: unknown, val: unknown) => ({ col, val, op: "eq" }),
  ne: (col: unknown, val: unknown) => ({ col, val, op: "ne" }),
}));

const { listAttachmentsHandler } = await import("./list-attachments.js");

// ── Test app ──────────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/:id/attachments", ...listAttachmentsHandler);
  return app;
}

const INST_ID = "00000000-0000-0000-0000-000000000002";

const fakeFileRow = {
  id: "file-1",
  originalName: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1024,
  scanStatus: "clean",
  uploadedBy: "u-bbb",
  createdAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockInstanceResult.length = 0;
  mockFilesResult.length = 0;
  mockAuth = {
    tenantId: "t-aaa",
    userId: "u-bbb",
    roles: ["agent"],
    email: "test@example.com",
  };
});

describe("GET /entities/:id/attachments", () => {
  it("returns 404 when the record does not exist", async () => {
    const res = await makeApp().request(`/${INST_ID}/attachments`);
    expect(res.status).toBe(404);
  });

  it("returns 200 with attachments for a privileged (agent) caller", async () => {
    mockInstanceResult.push({
      id: INST_ID,
      createdBy: null,
      assignedTo: null,
      fields: {},
    });
    mockFilesResult.push(fakeFileRow);

    const res = await makeApp().request(`/${INST_ID}/attachments`);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
  });

  it("returns 404 for a non-privileged user with no relation to a restricted record", async () => {
    mockAuth = {
      tenantId: "t-aaa",
      userId: "u-outsider",
      roles: ["user"],
      email: "outsider@example.com",
    };
    mockInstanceResult.push({
      id: INST_ID,
      createdBy: "u-owner",
      assignedTo: "u-other",
      fields: {},
    });
    mockFilesResult.push(fakeFileRow);

    const res = await makeApp().request(`/${INST_ID}/attachments`);

    expect(res.status).toBe(404);
  });

  it("returns 200 for a non-privileged user who is the assignee", async () => {
    mockAuth = {
      tenantId: "t-aaa",
      userId: "u-assignee",
      roles: ["user"],
      email: "assignee@example.com",
    };
    mockInstanceResult.push({
      id: INST_ID,
      createdBy: "u-owner",
      assignedTo: "u-assignee",
      fields: {},
    });
    mockFilesResult.push(fakeFileRow);

    const res = await makeApp().request(`/${INST_ID}/attachments`);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
  });

  it("returns 200 for a non-privileged user granted read_write access via __accessUsers", async () => {
    mockAuth = {
      tenantId: "t-aaa",
      userId: "u-granted",
      roles: ["user"],
      email: "granted@example.com",
    };
    mockInstanceResult.push({
      id: INST_ID,
      createdBy: "u-owner",
      assignedTo: null,
      fields: {
        __accessUsers: { "u-granted": { level: "read_write" } },
      },
    });
    mockFilesResult.push(fakeFileRow);

    const res = await makeApp().request(`/${INST_ID}/attachments`);

    expect(res.status).toBe(200);
  });
});
