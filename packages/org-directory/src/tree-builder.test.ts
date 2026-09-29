import { describe, it, expect } from "vitest";
import { buildOrgTree, type PriorEmployee } from "./tree-builder.js";
import type { OrgSourceRecord } from "./types.js";

function record(
  over: Partial<OrgSourceRecord> & { userId: string },
): OrgSourceRecord {
  return {
    managerId: null,
    department: null,
    name: "",
    title: "",
    email: "",
    ...over,
  };
}

describe("buildOrgTree — root attachment (R3)", () => {
  it("attaches an employee with no managerId to root", () => {
    const result = buildOrgTree(
      [record({ userId: "u1", managerId: null })],
      [],
    );
    expect(result.employees).toEqual([
      expect.objectContaining({ userId: "u1", parentUserId: null }),
    ]);
    expect(result.reparented).toBe(0);
    expect(result.cyclesBroken).toBe(0);
  });

  it("attaches an employee whose managerId never existed to root", () => {
    const result = buildOrgTree(
      [record({ userId: "u1", managerId: "ghost" })],
      [],
    );
    expect(result.employees[0]).toEqual(
      expect.objectContaining({ userId: "u1", parentUserId: null }),
    );
  });

  it("parents an employee to another employee present in the same pull", () => {
    const result = buildOrgTree(
      [
        record({ userId: "boss", managerId: null }),
        record({ userId: "report", managerId: "boss" }),
      ],
      [],
    );
    const report = result.employees.find((e) => e.userId === "report");
    expect(report?.parentUserId).toBe("boss");
  });
});

describe("buildOrgTree — one-hop reparent on manager removal (R5)", () => {
  it("reparents to the removed manager's own last-known parent", () => {
    const prior: PriorEmployee[] = [
      { userId: "grandboss", parentUserId: null },
      { userId: "removed-manager", parentUserId: "grandboss" },
    ];
    const fresh = [record({ userId: "report", managerId: "removed-manager" })];
    const result = buildOrgTree(fresh, prior);
    expect(result.employees[0]).toEqual(
      expect.objectContaining({ userId: "report", parentUserId: "grandboss" }),
    );
    expect(result.reparented).toBe(1);
  });

  it("falls back to root when the removed manager itself had no parent", () => {
    const prior: PriorEmployee[] = [
      { userId: "removed-manager", parentUserId: null },
    ];
    const fresh = [record({ userId: "report", managerId: "removed-manager" })];
    const result = buildOrgTree(fresh, prior);
    expect(result.employees[0]).toEqual(
      expect.objectContaining({ userId: "report", parentUserId: null }),
    );
    expect(result.reparented).toBe(1);
  });

  it("lists a user present in the prior tree but absent from the fresh pull as removed", () => {
    const prior: PriorEmployee[] = [
      { userId: "gone", parentUserId: null },
      { userId: "still-here", parentUserId: null },
    ];
    const fresh = [record({ userId: "still-here" })];
    const result = buildOrgTree(fresh, prior);
    expect(result.removedUserIds).toEqual(["gone"]);
  });
});

describe("buildOrgTree — cycle detection and break (R4)", () => {
  it("breaks a 2-node cycle (A -> B -> A)", () => {
    const fresh = [
      record({ userId: "a", managerId: "b" }),
      record({ userId: "b", managerId: "a" }),
    ];
    const result = buildOrgTree(fresh, []);
    expect(result.cyclesBroken).toBe(1);
    const rootAttached = result.employees.filter(
      (e) => e.parentUserId === null,
    );
    expect(rootAttached).toHaveLength(1);
    // exactly one of the two nodes in the loop now resolves to root
    expect(["a", "b"]).toContain(rootAttached[0]?.userId);
  });

  it("breaks a longer cycle (A -> B -> C -> A)", () => {
    const fresh = [
      record({ userId: "a", managerId: "b" }),
      record({ userId: "b", managerId: "c" }),
      record({ userId: "c", managerId: "a" }),
    ];
    const result = buildOrgTree(fresh, []);
    expect(result.cyclesBroken).toBe(1);
    expect(
      result.employees.filter((e) => e.parentUserId === null),
    ).toHaveLength(1);
  });

  it("does not flag a normal chain as a cycle", () => {
    const fresh = [
      record({ userId: "ceo", managerId: null }),
      record({ userId: "vp", managerId: "ceo" }),
      record({ userId: "eng", managerId: "vp" }),
    ];
    const result = buildOrgTree(fresh, []);
    expect(result.cyclesBroken).toBe(0);
  });

  it("catches a cycle created by a reparent, not just cycles already present in the fresh pull", () => {
    // "a" reports to "b" in the fresh pull. "b" reported to "removed", who
    // has since disappeared; "removed"'s own last-known manager was "a" --
    // so reparenting "b" one hop up (R5) resolves b -> a, which combined
    // with the fresh a -> b edge forms a brand-new a<->b cycle that did not
    // exist in either the fresh pull alone or the prior tree alone.
    const prior: PriorEmployee[] = [{ userId: "removed", parentUserId: "a" }];
    const fresh = [
      record({ userId: "a", managerId: "b" }),
      record({ userId: "b", managerId: "removed" }),
    ];
    const result = buildOrgTree(fresh, prior);
    expect(result.reparented).toBe(1);
    expect(result.cyclesBroken).toBe(1);
    expect(
      result.employees.filter((e) => e.parentUserId === null),
    ).toHaveLength(1);
  });

  it("handles two independent cycles in the same sync", () => {
    const fresh = [
      record({ userId: "a1", managerId: "a2" }),
      record({ userId: "a2", managerId: "a1" }),
      record({ userId: "b1", managerId: "b2" }),
      record({ userId: "b2", managerId: "b1" }),
    ];
    const result = buildOrgTree(fresh, []);
    expect(result.cyclesBroken).toBe(2);
  });
});

describe("buildOrgTree — department normalization (R6)", () => {
  it("lowercases and trims department", () => {
    const result = buildOrgTree(
      [record({ userId: "u1", department: "  Engineering  " })],
      [],
    );
    expect(result.employees[0]?.department).toBe("engineering");
  });

  it("stores an empty string, never a placeholder, when department is unset", () => {
    const result = buildOrgTree(
      [record({ userId: "u1", department: null })],
      [],
    );
    expect(result.employees[0]?.department).toBe("");
  });

  it("collapses differently-cased department names to one value", () => {
    const result = buildOrgTree(
      [
        record({ userId: "u1", department: "Engineering" }),
        record({ userId: "u2", department: "ENGINEERING" }),
      ],
      [],
    );
    expect(result.employees[0]?.department).toBe(
      result.employees[1]?.department,
    );
  });
});
