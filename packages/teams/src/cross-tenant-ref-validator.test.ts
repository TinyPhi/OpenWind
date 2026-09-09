import { describe, it, expect } from "vitest";
import { validateCrossTenantRefs } from "./cross-tenant-ref-validator.js";

describe("validateCrossTenantRefs", () => {
  it("returns no errors when refs is empty", async () => {
    const errors = await validateCrossTenantRefs([], async () => new Set());
    expect(errors).toEqual([]);
  });

  it("returns no errors when every ref resolves within the tenant (same-tenant ref passes)", async () => {
    const errors = await validateCrossTenantRefs(
      [{ fieldName: "teamId", refId: "team-1" }],
      async () => new Set(["team-1"]),
    );
    expect(errors).toEqual([]);
  });

  it("rejects a ref that belongs to a different tenant (cross-tenant ref rejected)", async () => {
    const errors = await validateCrossTenantRefs(
      [{ fieldName: "teamId", refId: "team-from-other-tenant" }],
      // lookupValidIds scopes to the current tenant -- a cross-tenant id
      // never appears in the valid set, indistinguishable from a
      // genuinely missing id (by design -- see security.md's 404-not-403 rule).
      async () => new Set(["team-1", "team-2"]),
    );
    expect(errors).toEqual([
      {
        field: "teamId",
        code: "INVALID_REFERENCE",
        message: "Referenced resource does not exist or is not accessible",
        meta: { refId: "team-from-other-tenant" },
      },
    ]);
  });

  it("rejects a ref that does not exist at all (missing ref rejected)", async () => {
    const errors = await validateCrossTenantRefs(
      [{ fieldName: "serviceId", refId: "does-not-exist" }],
      async () => new Set(),
    );
    expect(errors).toEqual([
      {
        field: "serviceId",
        code: "INVALID_REFERENCE",
        message: "Referenced resource does not exist or is not accessible",
        meta: { refId: "does-not-exist" },
      },
    ]);
  });

  it("validates multiple refs independently -- one bad ref does not suppress the others' results", async () => {
    const errors = await validateCrossTenantRefs(
      [
        { fieldName: "teamId", refId: "team-1" },
        { fieldName: "serviceId", refId: "service-from-other-tenant" },
      ],
      async () => new Set(["team-1"]),
    );
    expect(errors).toEqual([
      {
        field: "serviceId",
        code: "INVALID_REFERENCE",
        message: "Referenced resource does not exist or is not accessible",
        meta: { refId: "service-from-other-tenant" },
      },
    ]);
  });

  it("only calls lookupValidIds once with the full batch of refIds, not once per ref", async () => {
    let callCount = 0;
    let receivedIds: string[] = [];
    await validateCrossTenantRefs(
      [
        { fieldName: "a", refId: "id-1" },
        { fieldName: "b", refId: "id-2" },
      ],
      async (refIds) => {
        callCount++;
        receivedIds = refIds;
        return new Set(refIds);
      },
    );
    expect(callCount).toBe(1);
    expect(receivedIds).toEqual(["id-1", "id-2"]);
  });
});
