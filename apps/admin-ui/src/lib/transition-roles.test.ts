import { describe, it, expect } from "vitest";
import { filterTransitionsByRoles } from "./transition-roles.js";

const T = [
  { id: "open", allowedRoles: [] as string[] },
  { id: "unset" },
  { id: "approve", allowedRoles: ["approver"] },
  { id: "close", allowedRoles: ["agent", "admin"] },
];

describe("filterTransitionsByRoles", () => {
  it("keeps unrestricted transitions for any viewer", () => {
    expect(filterTransitionsByRoles(T, []).map((t) => t.id)).toEqual([
      "open",
      "unset",
    ]);
  });

  it("keeps a restricted transition only when a role matches", () => {
    expect(filterTransitionsByRoles(T, ["agent"]).map((t) => t.id)).toEqual([
      "open",
      "unset",
      "close",
    ]);
    expect(
      filterTransitionsByRoles(T, ["approver", "user"]).map((t) => t.id),
    ).toEqual(["open", "unset", "approve"]);
  });
});
