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

  it("does not permanently cache the no-token result — retries on the next call", async () => {
    // If the no-token branch left a resolved (empty) entry cached, a second
    // call for the same user would never re-hit the warn path below. Two
    // warnings for the same userId proves the cache was evicted, not just
    // that the result happens to look the same both times.
    mockLoggerWarn.mockClear();
    await getOrgMetadataForUser("user-retry-1");
    await getOrgMetadataForUser("user-retry-1");

    const noTokenWarnings = mockLoggerWarn.mock.calls.filter(
      ([, msg]) =>
        typeof msg === "string" && msg.includes("no service account token"),
    );
    expect(noTokenWarnings).toHaveLength(2);
  });
});

describe("parseOrgMetadataEntries", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  it("decodes manager_id, department, and title from base64-encoded metadata entries", () => {
    const result = parseOrgMetadataEntries([
      { key: "manager_id", value: b64("user-42") },
      { key: "department", value: b64("Engineering") },
      { key: "title", value: b64("Staff Engineer") },
    ]);

    expect(result).toEqual({
      managerId: "user-42",
      department: "Engineering",
      title: "Staff Engineer",
    });
  });

  it("ignores metadata keys outside the exact manager_id/department/title contract", () => {
    const result = parseOrgMetadataEntries([
      { key: "Manager_Id", value: b64("wrong-case") },
      { key: "phone_number", value: b64("unrelated") },
    ]);

    expect(result).toEqual({ managerId: null, department: null, title: null });
  });

  it("returns null for a field whose entry is missing entirely", () => {
    const result = parseOrgMetadataEntries([
      { key: "department", value: b64("Sales") },
    ]);

    expect(result).toEqual({
      managerId: null,
      department: "Sales",
      title: null,
    });
  });

  it("stores the best-effort decoded value for a malformed base64 entry, rather than skipping it", () => {
    const malformed = "not-valid-base64!!!";
    const result = parseOrgMetadataEntries([
      { key: "manager_id", value: malformed },
    ]);

    // Buffer.from(..., "base64") never throws -- it decodes best-effort,
    // it does not skip the entry. Asserting the exact decoded value (rather
    // than just "not null") documents the real behavior instead of implying
    // a skip that doesn't actually happen.
    expect(result.managerId).toBe(
      Buffer.from(malformed, "base64").toString("utf8"),
    );
  });
});
