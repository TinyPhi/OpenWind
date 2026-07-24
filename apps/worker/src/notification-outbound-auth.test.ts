import { describe, it, expect, vi, beforeEach } from "vitest";

const VALID_KEY = {
  type: "serviceaccount",
  keyId: "key-1",
  key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
  userId: "sa-user-1",
  expirationDate: "9999-12-31T23:59:59Z",
};

let envOverrides: {
  NOTIFICATION_ZITADEL_KEY_JSON?: string;
  NOTIFICATION_ZITADEL_AUDIENCE?: string;
  ZITADEL_ISSUER: string;
} = { ZITADEL_ISSUER: "https://issuer.example.com" };

vi.mock("@platform/config", () => ({
  get env() {
    return envOverrides;
  },
}));

vi.mock("@platform/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("jose", () => ({
  importPKCS8: vi.fn().mockResolvedValue("fake-private-key"),
  SignJWT: class {
    setProtectedHeader() {
      return this;
    }
    setIssuedAt() {
      return this;
    }
    setIssuer() {
      return this;
    }
    setSubject() {
      return this;
    }
    setAudience() {
      return this;
    }
    setExpirationTime() {
      return this;
    }
    async sign() {
      return "fake.assertion.jwt";
    }
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// The module keeps its token cache in module-scope variables — reset the
// module registry per test so each test starts from a clean cache instead of
// inheriting whatever the previous test's successful call cached.
async function freshGetToken() {
  vi.resetModules();
  const mod = await import("./notification-outbound-auth.js");
  return mod.getNotificationOutboundToken;
}

describe("getNotificationOutboundToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envOverrides = { ZITADEL_ISSUER: "https://issuer.example.com" };
  });

  it("returns null when NOTIFICATION_ZITADEL_KEY_JSON is not configured", async () => {
    envOverrides.NOTIFICATION_ZITADEL_AUDIENCE = "proj-1";
    const getToken = await freshGetToken();
    const token = await getToken();
    expect(token).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null when NOTIFICATION_ZITADEL_AUDIENCE is not configured", async () => {
    envOverrides.NOTIFICATION_ZITADEL_KEY_JSON = JSON.stringify(VALID_KEY);
    const getToken = await freshGetToken();
    const token = await getToken();
    expect(token).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("requests the project-scoped audience and returns the access token", async () => {
    envOverrides.NOTIFICATION_ZITADEL_KEY_JSON = JSON.stringify(VALID_KEY);
    envOverrides.NOTIFICATION_ZITADEL_AUDIENCE = "383173843264471042";
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "tok-abc", expires_in: 3600 }),
    });

    const getToken = await freshGetToken();
    const token = await getToken();

    expect(token).toBe("tok-abc");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, { body?: string }];
    expect(url).toBe("https://issuer.example.com/oauth/v2/token");
    const body = (init.body as string) ?? "";
    expect(body).toContain(
      "scope=openid+urn%3Azitadel%3Aiam%3Aorg%3Aproject%3Aid%3A383173843264471042%3Aaud",
    );
  });

  it("caches the token across calls instead of re-requesting", async () => {
    envOverrides.NOTIFICATION_ZITADEL_KEY_JSON = JSON.stringify(VALID_KEY);
    envOverrides.NOTIFICATION_ZITADEL_AUDIENCE = "383173843264471042";
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "tok-cached", expires_in: 3600 }),
    });

    const getToken = await freshGetToken();
    const first = await getToken();
    const second = await getToken();

    expect(first).toBe("tok-cached");
    expect(second).toBe("tok-cached");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns null when the token exchange fails", async () => {
    envOverrides.NOTIFICATION_ZITADEL_KEY_JSON = JSON.stringify(VALID_KEY);
    envOverrides.NOTIFICATION_ZITADEL_AUDIENCE = "383173843264471042";
    mockFetch.mockResolvedValue({ ok: false, status: 401 });

    const getToken = await freshGetToken();
    const token = await getToken();

    expect(token).toBeNull();
  });

  it("returns null when the configured key JSON is malformed", async () => {
    envOverrides.NOTIFICATION_ZITADEL_KEY_JSON = "not json";
    envOverrides.NOTIFICATION_ZITADEL_AUDIENCE = "383173843264471042";

    const getToken = await freshGetToken();
    const token = await getToken();

    expect(token).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
