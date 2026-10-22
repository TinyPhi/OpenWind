import { describe, it, expect, vi } from "vitest";

vi.mock("@platform/db", () => ({
  db: {},
  withTenantContext: vi.fn(),
  orgEmployees: {},
  orgDirectorySyncRuns: {},
}));

const { buildOrgTreeFromRows } = await import("./query.js");

const base = { title: "", department: "", email: "", isRoot: false };

describe("buildOrgTreeFromRows", () => {
  it("keys children by the parent's userId so every level can be walked from node.userId", () => {
    const tree = buildOrgTreeFromRows([
      {
        ...base,
        id: "row-root",
        userId: null,
        parentId: null,
        name: "Org",
        isRoot: true,
      },
      {
        ...base,
        id: "row-m",
        userId: "user-m",
        parentId: "row-root",
        name: "Manager",
      },
      {
        ...base,
        id: "row-e",
        userId: "user-e",
        parentId: "row-m",
        name: "Employee",
      },
    ]);

    expect(tree?.root.userId).toBe("row-root");
    const managers = tree?.nodesByParentId[tree.root.userId] ?? [];
    expect(managers.map((n) => n.name)).toEqual(["Manager"]);
    const manager = managers[0];
    const employees = tree?.nodesByParentId[manager?.userId ?? ""] ?? [];
    expect(employees.map((n) => n.name)).toEqual(["Employee"]);
    expect(employees[0]?.parentId).toBe("user-m");
  });

  it("returns null when there is no root row", () => {
    expect(buildOrgTreeFromRows([])).toBeNull();
  });
});
