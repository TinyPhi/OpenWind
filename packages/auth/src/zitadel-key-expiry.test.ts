import { describe, it, expect, vi, beforeEach } from "vitest";

const keyJson = (keyId: string, userId: string): string =>
  JSON.stringify({ type: "serviceaccount", keyId, key: "PRIVATE", userId });

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {} as Record<string, string | undefined>,
}));
vi.mock("@platform/config", () => ({ env: mockEnv }));

const mockListMachineKeys = vi.fn();
vi.mock("./zitadel-management.js", () => ({
  listMachineKeys: (...args: unknown[]) => mockListMachineKeys(...args),
}));

const { checkMachineKeyExpiry, parseMachineKeyRef } =
  await import("./zitadel-key-expiry.js");

const NOW = new Date("2026-10-15T00:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(mockEnv)) delete mockEnv[k];
});

describe("parseMachineKeyRef", () => {
  it("reads keyId and userId from a key file's JSON", () => {
    expect(parseMachineKeyRef(keyJson("key-123", "user-9"))).toEqual({
      keyId: "key-123",
      userId: "user-9",
    });
  });

  it("returns null for anything else", () => {
    expect(parseMachineKeyRef("not json")).toBeNull();
    expect(parseMachineKeyRef(JSON.stringify({ keyId: "x" }))).toBeNull();
  });
});

describe("checkMachineKeyExpiry", () => {
  it("decodes each variable exactly as its consumer does, so a mis-encoded key is reported", async () => {
    // NOTIFICATION_ZITADEL_KEY_JSON is read as raw JSON by the notification code: base64 there
    // breaks email, so it must not look fine here.
    mockEnv.NOTIFICATION_ZITADEL_KEY_JSON = Buffer.from(
      keyJson("noti-1", "u-noti"),
    ).toString("base64");
    // ZITADEL_KEY_JSON is base64; raw JSON there is unreadable to its consumer too.
    mockEnv.ZITADEL_KEY_JSON = keyJson("mgmt-1", "u-mgmt");

    const reports = await checkMachineKeyExpiry(NOW);

    expect(reports).toEqual([
      {
        name: "management",
        keyIdSuffix: "?",
        state: "unknown",
        reason: "unreadable_key_config",
      },
      {
        name: "notification",
        keyIdSuffix: "?",
        state: "unknown",
        reason: "unreadable_key_config",
      },
    ]);
    expect(mockListMachineKeys).not.toHaveBeenCalled();
  });

  it("prefers the raw-JSON variable over the base64 one, like the consumers", async () => {
    mockEnv.ZITADEL_PROVISIONING_SERVICE_ACCOUNT_KEY = keyJson(
      "raw-key1",
      "u-raw",
    );
    mockEnv.ZITADEL_PROVISIONING_KEY_JSON = Buffer.from(
      keyJson("b64-key1", "u-b64"),
    ).toString("base64");
    mockListMachineKeys.mockResolvedValue({ ok: true, keys: [] });

    await checkMachineKeyExpiry(NOW);

    expect(mockListMachineKeys).toHaveBeenCalledWith("u-raw");
  });

  it("reports each configured key's live expiry, by its last 6 key-id characters", async () => {
    mockEnv.ZITADEL_KEY_JSON = Buffer.from(
      keyJson("mgmt-abc123", "u-mgmt"),
    ).toString("base64");
    mockEnv.ZITADEL_PROVISIONING_SERVICE_ACCOUNT_KEY = keyJson(
      "prov-def456",
      "u-prov",
    );
    mockEnv.NOTIFICATION_ZITADEL_KEY_JSON = keyJson("noti-ghi789", "u-noti");
    mockListMachineKeys.mockImplementation((userId: string) =>
      Promise.resolve({
        ok: true,
        keys: [
          { id: "other", expirationDate: null },
          {
            id: {
              "u-mgmt": "mgmt-abc123",
              "u-prov": "prov-def456",
              "u-noti": "noti-ghi789",
            }[userId],
            expirationDate: new Date("2026-11-01T00:00:00Z"),
          },
        ],
      }),
    );

    const reports = await checkMachineKeyExpiry(NOW);

    expect(mockListMachineKeys.mock.calls.map((c) => c[0])).toEqual([
      "u-mgmt",
      "u-prov",
      "u-noti",
    ]);
    expect(reports).toEqual([
      {
        name: "management",
        keyIdSuffix: "abc123",
        state: "expires",
        expiresAt: new Date("2026-11-01T00:00:00Z"),
      },
      {
        name: "provisioning",
        keyIdSuffix: "def456",
        state: "expires",
        expiresAt: new Date("2026-11-01T00:00:00Z"),
      },
      {
        name: "notification",
        keyIdSuffix: "ghi789",
        state: "expires",
        expiresAt: new Date("2026-11-01T00:00:00Z"),
      },
    ]);
    // Key material never leaves this function.
    expect(JSON.stringify(reports)).not.toContain("PRIVATE");
  });

  it("treats no date, or a far-future placeholder, as never expiring", async () => {
    mockEnv.ZITADEL_SERVICE_ACCOUNT_KEY = keyJson("k-none", "u1");
    mockEnv.NOTIFICATION_ZITADEL_KEY_JSON = keyJson("k-9999", "u2");
    mockListMachineKeys.mockImplementation((userId: string) =>
      Promise.resolve({
        ok: true,
        keys: [
          userId === "u1"
            ? { id: "k-none", expirationDate: null }
            : {
                id: "k-9999",
                expirationDate: new Date("9999-01-01T00:00:00Z"),
              },
        ],
      }),
    );

    const reports = await checkMachineKeyExpiry(NOW);

    expect(reports.map((r) => [r.name, r.state])).toEqual([
      ["management", "never_expires"],
      ["notification", "never_expires"],
    ]);
  });

  it("reports a key Zitadel no longer lists as missing", async () => {
    mockEnv.ZITADEL_SERVICE_ACCOUNT_KEY = keyJson("gone-key", "u1");
    mockListMachineKeys.mockResolvedValue({
      ok: true,
      keys: [{ id: "a-newer-key", expirationDate: null }],
    });

    expect(await checkMachineKeyExpiry(NOW)).toEqual([
      { name: "management", keyIdSuffix: "ne-key", state: "missing" },
    ]);
  });

  it("reports a failed lookup or an unreadable key file as unknown, with the reason", async () => {
    mockEnv.ZITADEL_SERVICE_ACCOUNT_KEY = keyJson("k1", "u1");
    mockEnv.NOTIFICATION_ZITADEL_KEY_JSON = "garbage";
    mockListMachineKeys.mockResolvedValue({ ok: false, reason: "forbidden" });

    expect(await checkMachineKeyExpiry(NOW)).toEqual([
      {
        name: "management",
        keyIdSuffix: "k1",
        state: "unknown",
        reason: "forbidden",
      },
      {
        name: "notification",
        keyIdSuffix: "?",
        state: "unknown",
        reason: "unreadable_key_config",
      },
    ]);
  });

  it("leaves out keys that aren't configured", async () => {
    expect(await checkMachineKeyExpiry(NOW)).toEqual([]);
    expect(mockListMachineKeys).not.toHaveBeenCalled();
  });
});
