import { describe, it, expect } from "vitest";
import { detectScopesFormat } from "./scopes.js";

describe("detectScopesFormat", () => {
  it("returns 'role' for an empty scopes array", () => {
    expect(detectScopesFormat([])).toBe("role");
  });

  it("returns 'role' for legacy role-strings", () => {
    expect(detectScopesFormat(["admin"])).toBe("role");
    expect(detectScopesFormat(["user", "agent", "admin"])).toBe("role");
  });

  it("returns 'action' for entity:<entityType>:<verb> action-strings", () => {
    expect(detectScopesFormat(["entity:ticket:read"])).toBe("action");
    expect(
      detectScopesFormat(["entity:ticket:read", "entity:ticket:create"]),
    ).toBe("action");
  });

  it("throws when scopes mix role-strings and action-strings", () => {
    expect(() => detectScopesFormat(["admin", "entity:ticket:read"])).toThrow(
      /mix action-shaped and role-shaped/,
    );
  });

  it("treats a scope with the wrong number of segments as role-shaped, not action-shaped", () => {
    // Guards against a future verb containing a colon silently reclassifying —
    // only the confirmed 3-segment entity:<type>:<verb> shape counts as action.
    expect(detectScopesFormat(["entity:ticket"])).toBe("role");
    expect(detectScopesFormat(["entity:ticket:read:extra"])).toBe("role");
  });
});
