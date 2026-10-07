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
  NOTIFICATION_SERVICE_URL?: string;
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

async function freshModule() {
  vi.resetModules();
  return import("./outbound-dispatch.js");
}

beforeEach(() => {
  vi.clearAllMocks();
  envOverrides = { ZITADEL_ISSUER: "https://issuer.example.com" };
});

describe("sendDirectNotification", () => {
  it("throws when NOTIFICATION_SERVICE_URL is not configured", async () => {
    const { sendDirectNotification } = await freshModule();
    await expect(
      sendDirectNotification({
        notificationId: "n-1",
        title: "t",
        body: "b",
        recipients: [{ userId: "u-1", email: "a@example.com" }],
      }),
    ).rejects.toThrow("NOTIFICATION_SERVICE_URL");
  });

  it("posts to the configured service with the recipient payload, including the token when available", async () => {
    envOverrides.NOTIFICATION_SERVICE_URL =
      "https://notify.example.com/deliver";
    envOverrides.NOTIFICATION_ZITADEL_KEY_JSON = JSON.stringify(VALID_KEY);
    envOverrides.NOTIFICATION_ZITADEL_AUDIENCE = "proj-1";

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: "tok-abc", expires_in: 3600 }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const { sendDirectNotification } = await freshModule();
    await sendDirectNotification({
      notificationId: "n-1",
      title: "Your code",
      body: "123456",
      recipients: [{ userId: "pa-1", email: "pa@example.com" }],
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [url, init] = mockFetch.mock.calls[1] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://notify.example.com/deliver");
    expect(init.headers["Authorization"]).toBe("Bearer tok-abc");
    const body = JSON.parse(init.body);
    expect(body.recipients).toEqual([
      { userId: "pa-1", email: "pa@example.com" },
    ]);
    expect(body).not.toHaveProperty("tenantId");
  });

  it("dispatches without an Authorization header when no token is configured", async () => {
    envOverrides.NOTIFICATION_SERVICE_URL =
      "https://notify.example.com/deliver";
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

    const { sendDirectNotification } = await freshModule();
    await sendDirectNotification({
      notificationId: "n-1",
      title: "t",
      body: "b",
      recipients: [{ userId: "pa-1", email: "pa@example.com" }],
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers["Authorization"]).toBeUndefined();
  });

  it("throws when the outbound service responds with a non-2xx status", async () => {
    envOverrides.NOTIFICATION_SERVICE_URL =
      "https://notify.example.com/deliver";
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("internal error"),
    });

    const { sendDirectNotification } = await freshModule();
    await expect(
      sendDirectNotification({
        notificationId: "n-1",
        title: "t",
        body: "b",
        recipients: [{ userId: "pa-1", email: "pa@example.com" }],
      }),
    ).rejects.toThrow("500");
  });

  it("clears the cached token on a 401 so the next call re-fetches instead of retrying the same rejected token (review finding, PR #803)", async () => {
    envOverrides.NOTIFICATION_SERVICE_URL =
      "https://notify.example.com/deliver";
    envOverrides.NOTIFICATION_ZITADEL_KEY_JSON = JSON.stringify(VALID_KEY);
    envOverrides.NOTIFICATION_ZITADEL_AUDIENCE = "proj-1";

    const { sendDirectNotification } = await freshModule();

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: "tok-stale", expires_in: 3600 }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve("token revoked"),
      });

    await expect(
      sendDirectNotification({
        notificationId: "n-1",
        title: "t",
        body: "b",
        recipients: [{ userId: "pa-1", email: "pa@example.com" }],
      }),
    ).rejects.toThrow("401");

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: "tok-fresh", expires_in: 3600 }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    await sendDirectNotification({
      notificationId: "n-2",
      title: "t",
      body: "b",
      recipients: [{ userId: "pa-1", email: "pa@example.com" }],
    });

    // 4 total calls (2 per attempt) -- the second attempt re-exchanged for a token instead
    // of skipping straight to the outbound POST with the stale, already-rejected one.
    expect(mockFetch).toHaveBeenCalledTimes(4);
    const [, secondPostInit] = mockFetch.mock.calls[3] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(secondPostInit.headers["Authorization"]).toBe("Bearer tok-fresh");
  });
});
