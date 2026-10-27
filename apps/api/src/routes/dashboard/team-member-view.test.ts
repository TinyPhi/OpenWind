import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

const mockGetSubtreeMembers = vi.fn();
const mockResolveScopedIds = vi.fn();
const mockBuildSections = vi.fn();

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId: "tenant-1",
        userId: "me",
        displayName: "Me",
        roles: ["user"],
      } as unknown as AuthContext);
      await next();
    },
}));
vi.mock("@platform/org-directory", () => ({
  getSubtreeMembers: (...args: unknown[]) => mockGetSubtreeMembers(...args),
}));
vi.mock("../entities/scoped-access.js", () => ({
  resolveUserScopedEntityIds: (...args: unknown[]) =>
    mockResolveScopedIds(...args),
}));
vi.mock("./view-builder.js", () => ({
  DASHBOARD_SCOPE_LIMIT: 2000,
  boundDashboardScope: (ids: string[]) => ({
    ids: ids.slice(0, 2000),
    truncated: ids.length > 2000,
  }),
  buildScopedDashboardSections: (...args: unknown[]) =>
    mockBuildSections(...args),
}));
vi.mock("../../lib/handle-entity-error.js", () => ({
  handleEntityError: (c: Context) => c.json({ error: "INTERNAL" }, 500),
}));

const { teamMemberViewHandler } = await import("./team-member-view.js");

function request(userId: string): Promise<Response> {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/team-member-view/:userId", ...teamMemberViewHandler);
  return Promise.resolve(app.request(`/team-member-view/${userId}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSubtreeMembers.mockResolvedValue({
    ids: ["lead", "emp"],
    members: [
      { userId: "lead", name: "Lead Person" },
      { userId: "emp", name: "Emp Person" },
    ],
  });
  mockResolveScopedIds.mockResolvedValue(["t1"]);
  mockBuildSections.mockResolvedValue({
    workflows: [{ workflowId: "wf" }],
    tickets: { items: [{ entityId: "t1" }], totalQualifying: 1 },
    dueDates: { items: [], totalQualifying: 0 },
    slaRisk: { items: [], totalQualifying: 0 },
  });
});

describe("GET /dashboard/team-member-view/:userId", () => {
  it("shows a report's ticket sections, scoped to that report alone", async () => {
    const res = await request("emp");
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      targetUser: { userId: "emp", name: "Emp Person" },
      tickets: { totalQualifying: 1 },
    });
    expect(mockGetSubtreeMembers).toHaveBeenCalledWith("tenant-1", "me");
    expect(mockResolveScopedIds).toHaveBeenCalledWith("tenant-1", ["emp"], {
      limit: 2001,
    });
  });

  it("works for a report any number of levels down", async () => {
    mockGetSubtreeMembers.mockResolvedValue({
      ids: ["lead", "emp", "deep"],
      members: [
        { userId: "lead", name: "L" },
        { userId: "emp", name: "E" },
        { userId: "deep", name: "Deep Person" },
      ],
    });

    const res = await request("deep");

    expect(res.status).toBe(200);
  });

  it("returns only ticket sections: personal workspace sections are always empty", async () => {
    const res = await request("emp");
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(body.data).toMatchObject({
      adminWorkflows: [],
      savedViews: [],
      pendingApprovals: { items: [], totalQualifying: 0 },
    });
  });

  it.each([
    ["someone outside the caller's subtree", "outsider"],
    ["the caller themself", "me"],
    ["an unknown id", "no-such-user"],
  ])("answers 404, and queries no tickets, for %s", async (_label, target) => {
    const res = await request(target);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "NOT_FOUND",
      message: "User not found",
    });
    expect(mockResolveScopedIds).not.toHaveBeenCalled();
    expect(mockBuildSections).not.toHaveBeenCalled();
  });

  it("answers 404 for everyone when the caller has no reports", async () => {
    mockGetSubtreeMembers.mockResolvedValue({ ids: [], members: [] });

    expect((await request("emp")).status).toBe(404);
  });

  it("returns empty sections for a report with no tickets", async () => {
    mockResolveScopedIds.mockResolvedValue([]);

    const res = await request("emp");
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      targetUser: { userId: "emp" },
      truncated: false,
      tickets: { items: [], totalQualifying: 0 },
    });
    expect(mockBuildSections).not.toHaveBeenCalled();
  });

  it("marks a report view truncated and builds only the bounded ids", async () => {
    const ids = Array.from({ length: 2001 }, (_, index) => `ticket-${index}`);
    mockResolveScopedIds.mockResolvedValue(ids);

    const res = await request("emp");
    const body = (await res.json()) as { data: { truncated: boolean } };

    expect(body.data.truncated).toBe(true);
    expect(mockBuildSections.mock.calls[0]?.[1]).toEqual(ids.slice(0, 2000));
  });
});
