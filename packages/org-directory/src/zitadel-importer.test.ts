import { describe, it, expect, vi } from "vitest";

const mockLookupOrgIdByTenantId = vi.fn();
const mockListOrgUsers = vi.fn();
const mockGetOrgMetadataForUser = vi.fn();

vi.mock("@platform/auth", () => ({
  lookupOrgIdByTenantId: mockLookupOrgIdByTenantId,
  listOrgUsers: mockListOrgUsers,
  getOrgMetadataForUser: mockGetOrgMetadataForUser,
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { ZitadelOrgSourceImporter } = await import("./zitadel-importer.js");

describe("ZitadelOrgSourceImporter", () => {
  it("returns [] and does not call listOrgUsers when the tenant has no mapped org", async () => {
    mockLookupOrgIdByTenantId.mockResolvedValueOnce(null);

    const result = await new ZitadelOrgSourceImporter().fetchAll("tenant-1");

    expect(result).toEqual([]);
    expect(mockListOrgUsers).not.toHaveBeenCalled();
  });

  it("maps each org user + their metadata into an OrgSourceRecord", async () => {
    mockLookupOrgIdByTenantId.mockResolvedValueOnce("org-1");
    mockListOrgUsers.mockResolvedValueOnce([
      {
        userId: "u1",
        email: "jane@example.com",
        displayName: "Jane Doe",
        loginName: "jane",
        phone: undefined,
      },
    ]);
    mockGetOrgMetadataForUser.mockResolvedValueOnce({
      managerId: "u2",
      department: "engineering",
      title: "Staff Engineer",
    });

    const result = await new ZitadelOrgSourceImporter().fetchAll("tenant-1");

    expect(result).toEqual([
      {
        userId: "u1",
        managerId: "u2",
        department: "engineering",
        name: "Jane Doe",
        title: "Staff Engineer",
        email: "jane@example.com",
      },
    ]);
    expect(mockListOrgUsers).toHaveBeenCalledWith("org-1");
    expect(mockGetOrgMetadataForUser).toHaveBeenCalledWith("u1");
  });

  it("falls back to an empty title when metadata has none", async () => {
    mockLookupOrgIdByTenantId.mockResolvedValueOnce("org-1");
    mockListOrgUsers.mockResolvedValueOnce([
      {
        userId: "u1",
        email: "jane@example.com",
        displayName: "Jane Doe",
        loginName: "jane",
        phone: undefined,
      },
    ]);
    mockGetOrgMetadataForUser.mockResolvedValueOnce({
      managerId: null,
      department: null,
      title: null,
    });

    const result = await new ZitadelOrgSourceImporter().fetchAll("tenant-1");

    expect(result[0]?.title).toBe("");
  });
});
