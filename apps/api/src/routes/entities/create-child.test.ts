import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

// docs/specs/mandatory-ticket-fields.md R4 (owner decision 1): a sub-task needs the same
// five mandatory values as a full ticket.

const { mockAuth } = vi.hoisted(() => ({
  mockAuth: {
    tenantId: "t-aaa",
    userId: "u-bbb",
    roles: ["agent"] as string[],
    email: "agent@example.com",
    orgId: "org-1",
  },
}));

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", mockAuth as AuthContext);
      await next();
    },
  requireRole:
    (..._roles: string[]) =>
    async (_c: Context, next: Next) => {
      await next();
    },
}));

const mockCreateChildRelation = vi.fn();
vi.mock("@platform/entity-engine", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createChildRelation: (...args: unknown[]) => mockCreateChildRelation(...args),
}));

vi.mock("@platform/db", () => ({
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn({}),
}));

const mockEnsureTenantMembers = vi.fn();
vi.mock("../../lib/ensure-user-refs.js", () => ({
  ensureTenantMembers: (...args: unknown[]) => mockEnsureTenantMembers(...args),
}));

const mockPostRemarkComment = vi.fn();
vi.mock("../../lib/post-remark-comment.js", () => ({
  postRemarkComment: (...args: unknown[]) => mockPostRemarkComment(...args),
}));

vi.mock("../../lib/assert-record-workflow-access.js", () => ({
  assertRecordWorkflowAccess: vi.fn(),
}));

vi.mock("../../lib/handle-entity-error.js", () => ({
  handleEntityError: (c: Context, err: unknown) => {
    const fields = (err as { fields?: unknown }).fields;
    return c.json({ error: "VALIDATION_ERROR", fields }, 422);
  },
}));

const { createChildHandler } = await import("./create-child.js");

function makeApp(): Hono<{ Variables: { auth: AuthContext } }> {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.post("/entities/:id/children", ...createChildHandler);
  return app;
}

const ASSIGNEE = "395069484982861826";
const FUTURE = new Date(Date.now() + 3 * 86_400_000).toISOString();
const VALID = {
  entityTypeId: "11111111-1111-4111-8111-111111111111",
  fields: { title: "Swap the toner" },
  assignedTo: ASSIGNEE,
  dueDate: FUTURE,
  remark: "Needed before the board meeting",
};

function post(body: Record<string, unknown>): Promise<Response> {
  return Promise.resolve(
    makeApp().request("/entities/parent-1/children", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureTenantMembers.mockResolvedValue(new Set([ASSIGNEE]));
  mockCreateChildRelation.mockResolvedValue({
    instance: { id: "child-1", workflowId: "wf-1", currentState: "open" },
    relations: [],
  });
});

describe("POST /entities/:id/children — the four mandatory values", () => {
  it("creates a complete sub-task, defaulting severity, and posts the remark as the first comment", async () => {
    const res = await post(VALID);
    expect(res.status).toBe(201);
    expect(mockCreateChildRelation).toHaveBeenCalledWith(
      expect.anything(),
      "t-aaa",
      expect.objectContaining({
        parentId: "parent-1",
        assignedTo: ASSIGNEE,
        dueDate: FUTURE,
        remark: VALID.remark,
        severity: "medium",
      }),
    );
    expect(mockPostRemarkComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ instanceId: "child-1", text: VALID.remark }),
    );
  });

  it.each([
    ["a title", { fields: { title: "  " } }],
    ["a remark", { remark: undefined }],
    ["a due date", { dueDate: undefined }],
    ["a due date in the future", { dueDate: "2020-01-01T10:00:00.000Z" }],
  ])("refuses a sub-task without %s", async (_what, change) => {
    const res = await post({ ...VALID, ...change });
    expect(res.status).toBe(400);
    expect(mockCreateChildRelation).not.toHaveBeenCalled();
  });

  // The due date may trail the clock by up to 15s (DUE_DATE_GRACE_MS), as on createEntity.
  it.each([
    [14_000, 201],
    [16_000, 400],
  ])("treats a due date %ims in the past as %i", async (ago, status) => {
    const dueDate = new Date(Date.now() - ago).toISOString();
    const res = await post({ ...VALID, dueDate });
    expect(res.status).toBe(status);
  });

  it("refuses both an assignee and a team", async () => {
    const res = await post({
      ...VALID,
      teamId: "22222222-2222-4222-8222-222222222222",
    });
    expect(res.status).toBe(400);
  });

  // Owner decision 2026-10-19: an unassigned sub-task is allowed.
  it("creates an unassigned sub-task", async () => {
    const res = await post({ ...VALID, assignedTo: undefined });
    expect(res.status).toBe(201);
    expect(mockCreateChildRelation).toHaveBeenCalledWith(
      expect.anything(),
      "t-aaa",
      expect.objectContaining({ assignedTo: undefined }),
    );
  });

  it("accepts a team instead of an assignee, without a membership lookup", async () => {
    const teamId = "22222222-2222-4222-8222-222222222222";
    const res = await post({ ...VALID, assignedTo: undefined, teamId });
    expect(res.status).toBe(201);
    expect(mockEnsureTenantMembers).not.toHaveBeenCalled();
    expect(mockCreateChildRelation).toHaveBeenCalledWith(
      expect.anything(),
      "t-aaa",
      expect.objectContaining({ teamId, assignedTo: undefined }),
    );
  });

  it("refuses an assignee who isn't a member of the organisation", async () => {
    mockEnsureTenantMembers.mockResolvedValue(new Set());
    const res = await post(VALID);
    expect(res.status).toBe(422);
    expect(mockEnsureTenantMembers).toHaveBeenCalledWith(
      expect.anything(),
      "t-aaa",
      [ASSIGNEE],
      "org-1",
    );
    expect(mockCreateChildRelation).not.toHaveBeenCalled();
  });

  it("still returns 201 but flags remark_comment_failed when posting the remark comment fails", async () => {
    mockPostRemarkComment.mockRejectedValue(new Error("comment store down"));
    const res = await post(VALID);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: unknown; warnings?: string[] };
    expect(body.warnings).toEqual(["remark_comment_failed"]);
  });

  it("returns no warnings when the remark comment posts", async () => {
    mockPostRemarkComment.mockResolvedValue(undefined);
    const res = await post(VALID);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("warnings");
  });
});
