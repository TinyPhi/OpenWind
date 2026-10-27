import { describe, it, expect, vi } from "vitest";

const mockWithTenantContext = vi.hoisted(() => vi.fn());
vi.mock("@platform/db", () => ({
  db: {},
  withTenantContext: mockWithTenantContext,
  orgEmployees: {},
  orgDirectorySyncRuns: {},
}));

const { getSubtreeMembers, hasDirectReports } = await import("./query.js");

const base = { title: "", department: "", email: "", isRoot: false };

describe("getSubtreeMembers", () => {
  // root -> mgr -> lead -> (emp1, emp2); root -> other -> other-emp
  const rows = [
    {
      ...base,
      id: "r",
      userId: null,
      parentId: null,
      name: "Org",
      isRoot: true,
    },
    { ...base, id: "r-m", userId: "mgr", parentId: "r", name: "Manager" },
    { ...base, id: "r-l", userId: "lead", parentId: "r-m", name: "Lead" },
    { ...base, id: "r-e1", userId: "emp1", parentId: "r-l", name: "Emp One" },
    { ...base, id: "r-e2", userId: "emp2", parentId: "r-l", name: "Emp Two" },
    { ...base, id: "r-o", userId: "other", parentId: "r", name: "Other" },
    {
      ...base,
      id: "r-oe",
      userId: "other-emp",
      parentId: "r-o",
      name: "Other Emp",
    },
  ];

  it("returns every report at any depth, excluding the user and other branches", async () => {
    mockWithTenantContext.mockResolvedValue(rows);

    const result = await getSubtreeMembers("t1", "mgr");

    expect(result.ids.sort()).toEqual(["emp1", "emp2", "lead"]);
    expect(result.members.map((m) => m.name).sort()).toEqual([
      "Emp One",
      "Emp Two",
      "Lead",
    ]);
  });

  it("returns nothing for a leaf", async () => {
    mockWithTenantContext.mockResolvedValue(rows);

    expect(await getSubtreeMembers("t1", "emp1")).toEqual({
      ids: [],
      members: [],
    });
  });

  it("returns nothing for a user who is not in the tree", async () => {
    mockWithTenantContext.mockResolvedValue(rows);

    expect(await getSubtreeMembers("t1", "ghost")).toEqual({
      ids: [],
      members: [],
    });
  });

  it("never lists the user among their own reports, even if a cycle survives", async () => {
    // mgr -> lead -> mgr (a cycle the sync should have broken)
    mockWithTenantContext.mockResolvedValue([
      {
        ...base,
        id: "r",
        userId: null,
        parentId: null,
        name: "Org",
        isRoot: true,
      },
      { ...base, id: "r-m", userId: "mgr", parentId: "r-l", name: "Manager" },
      { ...base, id: "r-l", userId: "lead", parentId: "r-m", name: "Lead" },
    ]);

    const result = await getSubtreeMembers("t1", "mgr");

    expect(result.ids).toEqual(["lead"]);
  });

  it("excludes a null-user row and its invalid descendant branch", async () => {
    mockWithTenantContext.mockResolvedValue([
      ...rows,
      {
        ...base,
        id: "r-null",
        userId: null,
        parentId: "r-m",
        name: "Invalid row",
      },
      {
        ...base,
        id: "r-hidden",
        userId: "hidden",
        parentId: "r-null",
        name: "Hidden descendant",
      },
    ]);

    const result = await getSubtreeMembers("t1", "mgr");

    expect(result.ids).not.toContain("r-null");
    expect(result.ids).not.toContain("hidden");
  });
});

describe("hasDirectReports", () => {
  it("returns true after two bounded indexed existence lookups", async () => {
    const limit = vi
      .fn()
      .mockResolvedValueOnce([{ id: "manager-row" }])
      .mockResolvedValueOnce([{ id: "report-row" }]);
    const query = {
      from: vi.fn(),
      where: vi.fn(),
      limit,
    };
    query.from.mockReturnValue(query);
    query.where.mockReturnValue(query);
    const tx = { select: vi.fn(() => query) };
    mockWithTenantContext.mockImplementationOnce(
      async (_tenantId: string, callback: (arg: typeof tx) => unknown) =>
        callback(tx),
    );

    await expect(hasDirectReports("t1", "mgr")).resolves.toBe(true);
    expect(limit).toHaveBeenCalledTimes(2);
    expect(limit).toHaveBeenNthCalledWith(1, 1);
    expect(limit).toHaveBeenNthCalledWith(2, 1);
  });

  it("returns false without running the report lookup when the caller is absent", async () => {
    const limit = vi.fn().mockResolvedValueOnce([]);
    const query = {
      from: vi.fn(),
      where: vi.fn(),
      limit,
    };
    query.from.mockReturnValue(query);
    query.where.mockReturnValue(query);
    const tx = { select: vi.fn(() => query) };
    mockWithTenantContext.mockImplementationOnce(
      async (_tenantId: string, callback: (arg: typeof tx) => unknown) =>
        callback(tx),
    );

    await expect(hasDirectReports("t1", "ghost")).resolves.toBe(false);
    expect(limit).toHaveBeenCalledTimes(1);
  });
});
