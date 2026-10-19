import { describe, it, expect } from "vitest";
import { reorderFields } from "./field-order.js";

// docs/specs/mandatory-ticket-fields.md R1: the title is protected, so reordering never
// moves or renumbers it -- the API would refuse the change and leave the order half-saved.
const fields = [
  { id: "title", isSystem: true, sortOrder: 1 },
  { id: "a", isSystem: false, sortOrder: 2 },
  { id: "b", isSystem: false, sortOrder: 3 },
  { id: "c", isSystem: false, sortOrder: 4 },
];

describe("reorderFields", () => {
  it("moves a field and renumbers the others after the pinned title", () => {
    expect(reorderFields(fields, "c", "a")).toEqual([
      { id: "title", isSystem: true, sortOrder: 1 },
      { id: "c", isSystem: false, sortOrder: 11 },
      { id: "a", isSystem: false, sortOrder: 21 },
      { id: "b", isSystem: false, sortOrder: 31 },
    ]);
  });

  it("never moves a system field, nor lets one be a drop target", () => {
    expect(reorderFields(fields, "title", "b")).toBeNull();
    expect(reorderFields(fields, "b", "title")).toBeNull();
  });

  it("starts at 0 when there is no system field", () => {
    const plain = fields.filter((f) => !f.isSystem);
    expect(reorderFields(plain, "b", "a")?.map((f) => f.sortOrder)).toEqual([
      0, 10, 20,
    ]);
  });
});
