import { describe, expect, it } from "vitest";
import type { OrgNode, OrgSourceImporter, OrgTree } from "./index.js";

describe("@platform/org-directory package boundary", () => {
  it("exposes the OrgSourceImporter contract as the only provider-facing shape", () => {
    const stubImporter: OrgSourceImporter = {
      fetchAll: async () => [],
    };
    expect(typeof stubImporter.fetchAll).toBe("function");
  });

  it("OrgNode/OrgTree shapes support both flat (parentId) and tree traversal", () => {
    const root: OrgNode = {
      userId: "root",
      parentId: null,
      name: "Acme Inc",
      title: "",
      department: "",
      email: "",
      isRoot: true,
    };
    const tree: OrgTree = { root, nodesByParentId: {} };
    expect(tree.root.parentId).toBeNull();
    expect(tree.root.isRoot).toBe(true);
  });
});
