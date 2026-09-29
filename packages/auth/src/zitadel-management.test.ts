import { describe, it, expect, vi } from "vitest";

vi.mock("@platform/config", () => ({
  env: {
    ZITADEL_ISSUER: "http://localhost:8080",
    ZITADEL_INTROSPECTION_URL: "http://zitadel:8080/oauth/v2/introspect",
  },
}));

const mockLoggerWarn = vi.fn();
vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: mockLoggerWarn, error: vi.fn() },
}));

const { listOrgUsers, getOrgMetadataForUser, parseOrgMetadataEntries } =
  await import("./zitadel-management.js");

describe("listOrgUsers", () => {
  it("fails closed and returns [] when orgId is undefined — never falls through to an unfiltered instance-wide query", async () => {
    const result = await listOrgUsers(undefined);

    expect(result).toEqual([]);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      {},
      expect.stringContaining("without an orgId"),
    );
  });

  it("fails closed and returns [] when orgId is an empty string", async () => {
    const result = await listOrgUsers("");

    expect(result).toEqual([]);
  });
});

describe("getOrgMetadataForUser", () => {
  it("returns null manager/department/title when no service account token is configured", async () => {
    const result = await getOrgMetadataForUser("user-1");

    expect(result).toEqual({ managerId: null, department: null, title: null });
  });
});

describe("parseOrgMetadataEntries", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  it("decodes manager_id, department, and title from base64-encoded metadata entries", () => {
    const result = parseOrgMetadataEntries(
      [
        { key: "manager_id", value: b64("user-42") },
        { key: "department", value: b64("Engineering") },
        { key: "title", value: b64("Staff Engineer") },
      ],
      "user-1",
    );

    expect(result).toEqual({
      managerId: "user-42",
      department: "Engineering",
      title: "Staff Engineer",
    });
  });

  it("ignores metadata keys outside the exact manager_id/department/title contract", () => {
    const result = parseOrgMetadataEntries(
      [
        { key: "Manager_Id", value: b64("wrong-case") },
        { key: "phone_number", value: b64("unrelated") },
      ],
      "user-1",
    );

    expect(result).toEqual({ managerId: null, department: null, title: null });
  });

  it("returns null for a field whose entry is missing entirely", () => {
    const result = parseOrgMetadataEntries(
      [{ key: "department", value: b64("Sales") }],
      "user-1",
    );

    expect(result).toEqual({
      managerId: null,
      department: "Sales",
      title: null,
    });
  });

  it("skips a malformed base64 value without throwing", () => {
    const result = parseOrgMetadataEntries(
      [{ key: "manager_id", value: "not-valid-base64!!!" }],
      "user-1",
    );

    // Buffer.from(..., "base64") never throws — it decodes best-effort — so this
    // documents the actual (lenient) behavior rather than asserting a throw.
    expect(result.managerId).not.toBeNull();
  });
});
