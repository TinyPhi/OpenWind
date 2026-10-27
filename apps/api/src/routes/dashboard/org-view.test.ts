import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as ViewBuilder from "./view-builder.js";

const mockGetSubtreeMembers = vi.fn();
const mockHasDirectReports = vi.fn();
const mockResolveScopedIds = vi.fn();
const mockBuildSections = vi.fn();

const AUTH = {
  tenantId: "tenant-1",
  userId: "me",
  displayName: "Me Manager",
  roles: ["user"],
};

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", AUTH as unknown as AuthContext);
      await next();
    },
}));
vi.mock("@platform/org-directory", () => ({
  getSubtreeMembers: (...args: unknown[]) => mockGetSubtreeMembers(...args),
  hasDirectReports: (...args: unknown[]) => mockHasDirectReports(...args),
}));
vi.mock("../entities/scoped-access.js", () => ({
  resolveUserScopedEntityIds: (...args: unknown[]) =>
    mockResolveScopedIds(...args),
}));
vi.mock("./view-builder.js", async () => {
  // Real roster builder, mocked DB-backed pipeline.
  const actual = await vi.importActual<typeof ViewBuilder>("./view-builder.js");
  return {
    ...actual,
    buildScopedDashboardSections: (...args: unknown[]) =>
      mockBuildSections(...args),
  };
});
vi.mock("@platform/db", () => ({
  withTenantContext: vi.fn(),
  entityInstances: {},
  entityTypes: {},
  workflows: {},
  workflowStates: {},
}));
vi.mock("drizzle-orm", () => ({ eq: vi.fn(), inArray: vi.fn(), and: vi.fn() }));
vi.mock("@platform/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("../../lib/handle-entity-error.js", () => ({
  handleEntityError: (c: Context) => c.json({ error: "INTERNAL" }, 500),
}));

const { orgViewHandler, orgViewHasReportsHandler } =
  await import("./org-view.js");

function request(path = "/org-view"): Promise<Response> {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/org-view/has-reports", ...orgViewHasReportsHandler);
  app.get("/org-view", ...orgViewHandler);
  return Promise.resolve(app.request(path));
}

const PAST = new Date(Date.now() - 86_400_000);
const MEMBERS = [
  { userId: "lead", name: "Lead Person" },
  { userId: "emp", name: "Emp Person" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockHasDirectReports.mockResolvedValue(true);
  mockGetSubtreeMembers.mockResolvedValue({
    ids: ["lead", "emp"],
    members: MEMBERS,
  });
  mockResolveScopedIds.mockResolvedValue(["t1", "t2"]);
  mockBuildSections.mockResolvedValue({
    rows: [
      { id: "t1", assignedTo: "emp", dueDate: PAST },
      { id: "t2", assignedTo: "me", dueDate: null },
    ],
    workflows: [
      { workflowId: "wf", workflowName: "Helpdesk", counts: [], total: 2 },
    ],
    tickets: {
      items: [
        { entityId: "t1", assignedTo: "emp" },
        { entityId: "t2", assignedTo: "me" },
        { entityId: "t3", assignedTo: "outsider" },
        { entityId: "t4", assignedTo: null },
      ],
      totalQualifying: 4,
    },
    dueDates: { items: [], totalQualifying: 0 },
    slaRisk: { items: [], totalQualifying: 0 },
  });
});

describe("GET /dashboard/org-view", () => {
  it("answers the cheap self-scoped has-reports probe without building the subtree or reading tickets", async () => {
    const res = await request("/org-view/has-reports");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { hasReports: true } });
    expect(mockHasDirectReports).toHaveBeenCalledWith("tenant-1", "me");
    expect(mockGetSubtreeMembers).not.toHaveBeenCalled();
    expect(mockResolveScopedIds).not.toHaveBeenCalled();
    expect(mockBuildSections).not.toHaveBeenCalled();
  });

  it("returns hasReports:false from the cheap probe", async () => {
    mockHasDirectReports.mockResolvedValue(false);

    const res = await request("/org-view/has-reports");

    expect(await res.json()).toEqual({ data: { hasReports: false } });
  });

  it("reports hasReports:false, empty sections and no ticket query when the caller has no reports", async () => {
    mockGetSubtreeMembers.mockResolvedValue({ ids: [], members: [] });

    const res = await request();
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      hasReports: false,
      truncated: false,
      teamMembers: { items: [] },
      tickets: { items: [], totalQualifying: 0 },
    });
    expect(mockResolveScopedIds).not.toHaveBeenCalled();
  });

  it("scopes tickets to the caller plus their whole subtree, in the caller's tenant", async () => {
    await request();

    expect(mockGetSubtreeMembers).toHaveBeenCalledWith("tenant-1", "me");
    expect(mockResolveScopedIds).toHaveBeenCalledWith(
      "tenant-1",
      ["me", "lead", "emp"],
      expect.objectContaining({ limit: expect.any(Number) }),
    );
  });

  it("never takes the target user from the request", async () => {
    await request("/org-view?userId=someone-else");

    expect(mockGetSubtreeMembers).toHaveBeenCalledWith("tenant-1", "me");
  });

  it("returns a roster row per report with names from the tree and counts by assignee", async () => {
    const res = await request();
    const body = (await res.json()) as {
      data: { hasReports: boolean; teamMembers: { items: unknown[] } };
    };

    expect(body.data.hasReports).toBe(true);
    expect(body.data.teamMembers.items).toEqual([
      { userId: "lead", name: "Lead Person", ticketCount: 0, overdueCount: 0 },
      { userId: "emp", name: "Emp Person", ticketCount: 1, overdueCount: 1 },
    ]);
  });

  it("names assignees the caller can see in the tree, and hides anyone outside it", async () => {
    const res = await request();
    const body = (await res.json()) as {
      data: {
        tickets: {
          items: Array<{
            assignedTo: string | null;
            assignedToName: string | null;
          }>;
        };
      };
    };

    expect(
      body.data.tickets.items.map((t) => [t.assignedTo, t.assignedToName]),
    ).toEqual([
      ["emp", "Emp Person"],
      ["me", "Me Manager"],
      [null, null], // "outsider" is not in the caller's subtree: no id, no name
      [null, null],
    ]);
    expect(mockBuildSections).toHaveBeenCalledWith(
      "tenant-1",
      ["t1", "t2"],
      expect.any(Date),
      expect.anything(),
      { includeAssignee: true },
    );
  });

  it("returns the roster with zero counts when nothing is in scope", async () => {
    mockResolveScopedIds.mockResolvedValue([]);

    const res = await request();
    const body = (await res.json()) as {
      data: {
        hasReports: boolean;
        truncated: boolean;
        teamMembers: { items: unknown[] };
      };
    };

    expect(body.data.hasReports).toBe(true);
    expect(body.data.truncated).toBe(false);
    expect(body.data.teamMembers.items).toHaveLength(2);
    expect(mockBuildSections).not.toHaveBeenCalled();
  });

  it("fails on its own without touching My View when the tree lookup throws", async () => {
    mockGetSubtreeMembers.mockRejectedValue(new Error("db down"));

    const res = await request();

    expect(res.status).toBe(500);
  });

  it("marks and bounds a scope larger than the dashboard limit", async () => {
    const ids = Array.from({ length: 2001 }, (_, index) => `ticket-${index}`);
    mockResolveScopedIds.mockResolvedValue(ids);
    mockBuildSections.mockResolvedValue({
      rows: [],
      workflows: [],
      tickets: { items: [], totalQualifying: 2000 },
      dueDates: { items: [], totalQualifying: 0 },
      slaRisk: { items: [], totalQualifying: 0 },
    });

    const res = await request();
    const body = (await res.json()) as {
      data: { truncated: boolean };
    };

    expect(body.data.truncated).toBe(true);
    expect(mockResolveScopedIds).toHaveBeenCalledWith(
      "tenant-1",
      ["me", "lead", "emp"],
      { limit: 2001 },
    );
    expect(mockBuildSections.mock.calls[0]?.[1]).toEqual(ids.slice(0, 2000));
  });

  it("does not mark exactly the dashboard limit as truncated", async () => {
    mockResolveScopedIds.mockResolvedValue(
      Array.from({ length: 2000 }, (_, index) => `ticket-${index}`),
    );
    mockBuildSections.mockResolvedValue({
      rows: [],
      workflows: [],
      tickets: { items: [], totalQualifying: 2000 },
      dueDates: { items: [], totalQualifying: 0 },
      slaRisk: { items: [], totalQualifying: 0 },
    });

    const res = await request();
    const body = (await res.json()) as {
      data: { truncated: boolean };
    };

    expect(body.data.truncated).toBe(false);
  });
});
