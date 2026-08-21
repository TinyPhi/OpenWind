import { describe, it, expect } from "vitest";
import { detectScopesFormat, unknownTicketActionScopes } from "./scopes.js";

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

describe("unknownTicketActionScopes (ADR-012 Phase A, spec R8)", () => {
  it("returns an empty array when every scope is in the known vocabulary", () => {
    expect(
      unknownTicketActionScopes([
        "entity:ticket:create",
        "entity:ticket:read",
        "entity:ticket:comment",
        "entity:ticket:transition",
        "entity:ticket:subticket",
        "entity:ticket:attach",
      ]),
    ).toEqual([]);
  });

  it("flags a scope string outside the six known verbs", () => {
    expect(unknownTicketActionScopes(["entity:ticket:delete"])).toEqual([
      "entity:ticket:delete",
    ]);
  });

  it("flags an unrelated entity type even if the verb is known", () => {
    expect(unknownTicketActionScopes(["entity:workflow:read"])).toEqual([
      "entity:workflow:read",
    ]);
  });

  it("returns only the unknown ones out of a mixed valid/invalid array", () => {
    expect(
      unknownTicketActionScopes(["entity:ticket:read", "entity:ticket:bogus"]),
    ).toEqual(["entity:ticket:bogus"]);
  });
});
