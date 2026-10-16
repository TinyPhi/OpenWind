import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockEnv: Record<string, string | undefined> = {};

vi.mock("@platform/config", () => ({ env: mockEnv }));
vi.mock("@platform/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { openbaoRequest, __resetOpenBaoClientForTests } =
  await import("./client.js");

const ADDR = "https://openbao.example.test:8200";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function loginOk(token: string, leaseSeconds = 3600, renewable = true) {
  return json(200, {
    auth: { client_token: token, lease_duration: leaseSeconds, renewable },
  });
}

const fetchMock = vi.fn<typeof fetch>();

function callsTo(suffix: string) {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix));
}

beforeEach(() => {
  for (const k of Object.keys(mockEnv)) delete mockEnv[k];
  Object.assign(mockEnv, {
    OPENBAO_ADDR: ADDR,
    OPENBAO_ROLE_ID: "role-id",
    OPENBAO_SECRET_ID: "secret-id",
  });
  __resetOpenBaoClientForTests();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("openbaoRequest", () => {
  it("sends every request with a timeout signal", async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk("t1"))
      .mockResolvedValueOnce(json(200, { data: { ok: true } }));

    await openbaoRequest("POST", "transit/decrypt/k", {});

    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("retries a 503 (sealed) and then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk("t1"))
      .mockResolvedValueOnce(json(503, { errors: ["sealed"] }))
      .mockResolvedValueOnce(json(200, { data: { ok: true } }));

    await expect(
      openbaoRequest("POST", "transit/decrypt/k", {}),
    ).resolves.toEqual({ data: { ok: true } });
    expect(callsTo("/transit/decrypt/k")).toHaveLength(2);
  });

  it("retries a network error and then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk("t1"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(json(200, { data: { ok: true } }));

    await expect(
      openbaoRequest("POST", "transit/decrypt/k", {}),
    ).resolves.toEqual({ data: { ok: true } });
  });

  it("gives up after 3 attempts on repeated 5xx", async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk("t1"))
      .mockResolvedValue(json(503, { errors: ["sealed"] }));

    await expect(
      openbaoRequest("POST", "transit/decrypt/k", {}),
    ).rejects.toThrow("OpenBao error 503");
    expect(callsTo("/transit/decrypt/k")).toHaveLength(3);
  });

  it("does not retry a 400", async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk("t1"))
      .mockResolvedValueOnce(json(400, { errors: ["bad request"] }));

    await expect(
      openbaoRequest("POST", "transit/decrypt/k", {}),
    ).rejects.toThrow("OpenBao error 400");
    expect(callsTo("/transit/decrypt/k")).toHaveLength(1);
  });

  it("logs in again once after a 403 and retries the request", async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk("t1"))
      .mockResolvedValueOnce(json(403, { errors: ["permission denied"] }))
      .mockResolvedValueOnce(loginOk("t2"))
      .mockResolvedValueOnce(json(200, { data: { ok: true } }));

    await expect(
      openbaoRequest("POST", "transit/decrypt/k", {}),
    ).resolves.toEqual({ data: { ok: true } });
    expect(callsTo("/auth/approle/login")).toHaveLength(2);
    const last = callsTo("/transit/decrypt/k").at(-1);
    expect(
      (last?.[1]?.headers as Record<string, string>)["x-vault-token"],
    ).toBe("t2");
  });

  it("fails after a second 403 instead of looping", async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk("t1"))
      .mockResolvedValueOnce(json(403, { errors: ["permission denied"] }))
      .mockResolvedValueOnce(loginOk("t2"))
      .mockResolvedValueOnce(json(403, { errors: ["permission denied"] }));

    await expect(
      openbaoRequest("POST", "transit/decrypt/k", {}),
    ).rejects.toThrow("OpenBao error 403");
    expect(callsTo("/auth/approle/login")).toHaveLength(2);
  });

  it("does not force another login on a 403 within 5 s (policy denial)", async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk("t1"))
      .mockResolvedValueOnce(json(403, { errors: ["permission denied"] }))
      .mockResolvedValueOnce(loginOk("t2"))
      .mockResolvedValueOnce(json(403, { errors: ["permission denied"] }))
      .mockResolvedValueOnce(json(403, { errors: ["permission denied"] }));

    await expect(
      openbaoRequest("POST", "transit/decrypt/k", {}),
    ).rejects.toThrow("OpenBao error 403");
    // Second request right away: the fresh token is kept, no new login.
    await expect(
      openbaoRequest("POST", "transit/decrypt/k", {}),
    ).rejects.toThrow("OpenBao error 403");
    expect(callsTo("/auth/approle/login")).toHaveLength(2);
  });

  it("allows a forced re-login again once 5 s have passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    fetchMock
      .mockResolvedValueOnce(loginOk("t1"))
      .mockResolvedValueOnce(json(403, { errors: ["permission denied"] }))
      .mockResolvedValueOnce(loginOk("t2"))
      .mockResolvedValueOnce(json(200, { data: { ok: true } }));
    await openbaoRequest("POST", "transit/decrypt/k", {});

    vi.setSystemTime(new Date("2026-01-01T00:00:06Z"));
    fetchMock
      .mockResolvedValueOnce(json(403, { errors: ["permission denied"] }))
      .mockResolvedValueOnce(loginOk("t3"))
      .mockResolvedValueOnce(json(200, { data: { ok: true } }));
    await openbaoRequest("POST", "transit/decrypt/k", {});

    expect(callsTo("/auth/approle/login")).toHaveLength(3);
  });

  it("puts only a short summary of the error body in the log and the error", async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk("t1"))
      .mockResolvedValueOnce(
        json(400, { errors: ["bad request: " + "x".repeat(500)] }),
      );

    const err = await openbaoRequest("POST", "transit/decrypt/k", {}).catch(
      (e: unknown) => e as Error,
    );
    expect(err.message.startsWith("OpenBao error 400: bad request: ")).toBe(
      true,
    );
    expect(err.message.length).toBeLessThan(260);
    expect(err.message).not.toContain('"errors"');
  });

  it("does not retry a refused login", async () => {
    fetchMock.mockResolvedValueOnce(
      json(400, { errors: ["invalid role or secret ID"] }),
    );

    await expect(
      openbaoRequest("POST", "transit/decrypt/k", {}),
    ).rejects.toThrow("AppRole login failed (400)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses the token while it is fresh", async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk("t1"))
      .mockImplementation(() =>
        Promise.resolve(json(200, { data: { ok: true } })),
      );

    await openbaoRequest("POST", "transit/decrypt/k", {});
    await openbaoRequest("POST", "transit/decrypt/k", {});

    expect(callsTo("/auth/approle/login")).toHaveLength(1);
  });

  it("renews the token at about 2/3 of its lease, before it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    fetchMock.mockImplementation((url) => {
      const u = String(url);
      if (u.endsWith("/auth/approle/login"))
        return Promise.resolve(loginOk("t1", 3600));
      if (u.endsWith("/auth/token/renew-self"))
        return Promise.resolve(loginOk("t1", 3600));
      return Promise.resolve(json(200, { data: { ok: true } }));
    });

    await openbaoRequest("POST", "transit/decrypt/k", {});
    vi.setSystemTime(new Date("2026-01-01T00:30:00Z")); // 1/2 of the lease
    await openbaoRequest("POST", "transit/decrypt/k", {});
    expect(callsTo("/auth/token/renew-self")).toHaveLength(0);

    vi.setSystemTime(new Date("2026-01-01T00:41:00Z")); // past 2/3
    await openbaoRequest("POST", "transit/decrypt/k", {});
    expect(callsTo("/auth/token/renew-self")).toHaveLength(1);
    expect(callsTo("/auth/approle/login")).toHaveLength(1);
  });

  it("logs in again when renewal is refused", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    fetchMock.mockImplementation((url) => {
      const u = String(url);
      if (u.endsWith("/auth/approle/login"))
        return Promise.resolve(loginOk("t1", 3600));
      if (u.endsWith("/auth/token/renew-self"))
        return Promise.resolve(json(403, { errors: ["permission denied"] }));
      return Promise.resolve(json(200, { data: { ok: true } }));
    });

    await openbaoRequest("POST", "transit/decrypt/k", {});
    vi.setSystemTime(new Date("2026-01-01T00:50:00Z"));
    await openbaoRequest("POST", "transit/decrypt/k", {});

    expect(callsTo("/auth/approle/login")).toHaveLength(2);
  });

  it("shares one login between concurrent requests", async () => {
    let releaseLogin: (r: Response) => void = () => {};
    fetchMock.mockImplementation((url) => {
      if (String(url).endsWith("/auth/approle/login")) {
        return new Promise<Response>((resolve) => {
          releaseLogin = resolve;
        });
      }
      return Promise.resolve(json(200, { data: { ok: true } }));
    });

    const requests = Promise.all(
      Array.from({ length: 5 }, () =>
        openbaoRequest("POST", "transit/decrypt/k", {}),
      ),
    );
    await vi.waitFor(() =>
      expect(callsTo("/auth/approle/login")).toHaveLength(1),
    );
    releaseLogin(loginOk("t1"));
    await requests;

    expect(callsTo("/auth/approle/login")).toHaveLength(1);
    expect(callsTo("/transit/decrypt/k")).toHaveLength(5);
  });

  it("uses a static token without logging in", async () => {
    mockEnv["OPENBAO_TOKEN"] = "static-token";
    fetchMock.mockResolvedValueOnce(json(200, { data: { ok: true } }));

    await openbaoRequest("POST", "transit/decrypt/k", {});

    expect(callsTo("/auth/approle/login")).toHaveLength(0);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect((init?.headers as Record<string, string>)["x-vault-token"]).toBe(
      "static-token",
    );
  });
});
