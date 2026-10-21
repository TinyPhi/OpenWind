import { describe, it, expect } from "vitest";
import { auditResourceId } from "./resource-id.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("auditResourceId", () => {
  it("returns a valid version 5 uuid for a numeric Zitadel user id", () => {
    expect(auditResourceId("256000000000000001")).toMatch(UUID);
  });

  it("is deterministic and distinct per id", () => {
    expect(auditResourceId("256000000000000001")).toBe(
      auditResourceId("256000000000000001"),
    );
    expect(auditResourceId("256000000000000001")).not.toBe(
      auditResourceId("256000000000000002"),
    );
  });

  it("returns an existing uuid unchanged (lower-cased)", () => {
    const id = "AAAAAAAA-0000-4000-A000-000000000001";
    expect(auditResourceId(id)).toBe(id.toLowerCase());
  });

  it("matches an independent UUIDv5 implementation (Python uuid5) and stays pinned across releases", () => {
    expect(auditResourceId("256000000000000001")).toBe(
      "3d49c54f-3def-54e3-bf95-6787aaa0c6ce",
    );
  });
});
