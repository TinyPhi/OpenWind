import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();
const mockRedisDel = vi.fn();

vi.mock("@platform/redis", () => ({
  getRedis: () => ({ get: mockRedisGet, set: mockRedisSet, del: mockRedisDel }),
}));

const {
  storeSandboxHandoverCredentials,
  getSandboxHandoverCredentials,
  deleteSandboxHandoverCredentials,
} = await import("./sandbox-handover-store.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockRedisSet.mockResolvedValue("OK");
  mockRedisDel.mockResolvedValue(1);
});

describe("storeSandboxHandoverCredentials", () => {
  it("stores the credentials as JSON with a 7-day TTL, keyed by tenant id", async () => {
    const credentials = {
      seededAccounts: [
        {
          username: "admin.user",
          email: "admin@example.com",
          role: "admin" as const,
          password: "Ow-abc-9!",
        },
      ],
    };
    await storeSandboxHandoverCredentials("tenant-1", credentials);

    expect(mockRedisSet).toHaveBeenCalledWith(
      "platform-admin:sandbox-handover:tenant-1",
      JSON.stringify(credentials),
      "EX",
      7 * 24 * 60 * 60,
    );
  });
});

describe("getSandboxHandoverCredentials", () => {
  it("returns the stored per-account credentials when present", async () => {
    const credentials = {
      seededAccounts: [
        {
          username: "admin.user",
          email: "admin@example.com",
          role: "admin",
          password: "Ow-admin-9!",
        },
        {
          username: "olivia.smith",
          email: "olivia.smith@example.com",
          role: "user",
          password: "Ow-olivia-9!",
        },
      ],
    };
    mockRedisGet.mockResolvedValueOnce(JSON.stringify(credentials));

    const result = await getSandboxHandoverCredentials("tenant-1");

    expect(mockRedisGet).toHaveBeenCalledWith(
      "platform-admin:sandbox-handover:tenant-1",
    );
    expect(result).toEqual(credentials);
  });

  it("gives every account the shared password of a handover stored before per-account passwords", async () => {
    mockRedisGet.mockResolvedValueOnce(
      JSON.stringify({
        seededAccounts: [
          { username: "admin.user", email: "admin@example.com", role: "admin" },
          { username: "olivia.smith", email: "o@example.com", role: "user" },
        ],
        defaultPassword: "Ow-shared-9!",
      }),
    );

    const result = await getSandboxHandoverCredentials("tenant-1");

    expect(result).toEqual({
      seededAccounts: [
        {
          username: "admin.user",
          email: "admin@example.com",
          role: "admin",
          password: "Ow-shared-9!",
        },
        {
          username: "olivia.smith",
          email: "o@example.com",
          role: "user",
          password: "Ow-shared-9!",
        },
      ],
    });
    expect(result).not.toHaveProperty("defaultPassword");
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

  it.each([
    ["JSON null", "null"],
    ["no account list", JSON.stringify({ defaultPassword: "Ow-abc-9!" })],
    [
      "an account with no password on file",
      JSON.stringify({
        seededAccounts: [
          { username: "admin.user", email: "a@example.com", role: "admin" },
        ],
      }),
    ],
  ])(
    "returns null for a well-formed but unusable value (%s)",
    async (_, raw) => {
      mockRedisGet.mockResolvedValueOnce(raw);

      const result = await getSandboxHandoverCredentials("tenant-1");

      expect(result).toBeNull();
    },
  );
});

describe("deleteSandboxHandoverCredentials", () => {
  it("deletes the key for the given tenant id (T14, so a purged sandbox's credentials are not retrievable until the TTL passes)", async () => {
    await deleteSandboxHandoverCredentials("tenant-1");

    expect(mockRedisDel).toHaveBeenCalledWith(
      "platform-admin:sandbox-handover:tenant-1",
    );
  });

  it("is a no-op (does not throw) when nothing was ever stored for this tenant", async () => {
    mockRedisDel.mockResolvedValueOnce(0);

    await expect(
      deleteSandboxHandoverCredentials("tenant-never-provisioned"),
    ).resolves.toBeUndefined();
  });
});
