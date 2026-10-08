import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();

vi.mock("@platform/redis", () => ({
  getRedis: () => ({ get: mockRedisGet, set: mockRedisSet }),
}));

const { storeSandboxHandoverCredentials, getSandboxHandoverCredentials } =
  await import("./sandbox-handover-store.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockRedisSet.mockResolvedValue("OK");
});

describe("storeSandboxHandoverCredentials", () => {
  it("stores the credentials as JSON with a 7-day TTL, keyed by tenant id", async () => {
    await storeSandboxHandoverCredentials("tenant-1", {
      seededAccounts: [{ email: "admin@example.com", role: "admin" }],
      defaultPassword: "Ow-abc-9!",
    });

    expect(mockRedisSet).toHaveBeenCalledWith(
      "platform-admin:sandbox-handover:tenant-1",
      JSON.stringify({
        seededAccounts: [{ email: "admin@example.com", role: "admin" }],
        defaultPassword: "Ow-abc-9!",
      }),
      "EX",
      7 * 24 * 60 * 60,
    );
  });
});

describe("getSandboxHandoverCredentials", () => {
  it("returns the stored credentials when present", async () => {
    mockRedisGet.mockResolvedValueOnce(
      JSON.stringify({
        seededAccounts: [{ email: "admin@example.com", role: "admin" }],
        defaultPassword: "Ow-abc-9!",
      }),
    );

    const result = await getSandboxHandoverCredentials("tenant-1");

    expect(mockRedisGet).toHaveBeenCalledWith(
      "platform-admin:sandbox-handover:tenant-1",
    );
    expect(result).toEqual({
      seededAccounts: [{ email: "admin@example.com", role: "admin" }],
      defaultPassword: "Ow-abc-9!",
    });
  });

  it("returns null when nothing is stored (never provisioned, or the TTL expired)", async () => {
    mockRedisGet.mockResolvedValueOnce(null);

    const result = await getSandboxHandoverCredentials("tenant-1");

    expect(result).toBeNull();
  });

  it("returns null instead of throwing on a corrupted stored value", async () => {
    mockRedisGet.mockResolvedValueOnce("{not valid json");

    const result = await getSandboxHandoverCredentials("tenant-1");

    expect(result).toBeNull();
  });
});
