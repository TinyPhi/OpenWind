import { describe, it, expect, vi } from "vitest";

const mockWithTenantContext = vi.hoisted(() => vi.fn());
vi.mock("@platform/db", () => ({
  db: {},
  withTenantContext: mockWithTenantContext,
  orgEmployees: {},
  orgDirectorySyncRuns: {},
}));

const { getSubtreeMembers } = await import("./query.js");

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
});
