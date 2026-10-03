import type { ClientRequest, IncomingMessage } from "node:http";
import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    ZITADEL_ISSUER: "http://localhost:8080",
    ZITADEL_INTROSPECTION_URL: "http://zitadel:8080/oauth/v2/introspect",
    ZITADEL_SERVICE_ACCOUNT_KEY: undefined as string | undefined,
  },
}));
vi.mock("@platform/config", () => ({ env: mockEnv }));

const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();
vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: mockLoggerWarn, error: mockLoggerError },
}));

const mockHttpRequest = vi.fn();
vi.mock("node:http", () => ({ request: mockHttpRequest }));

vi.mock("jose", () => ({
  importPKCS8: vi.fn().mockResolvedValue({}),
  SignJWT: class {
    setProtectedHeader(): this {
      return this;
    }
    setIssuedAt(): this {
      return this;
    }
    setIssuer(): this {
      return this;
    }
    setSubject(): this {
      return this;
    }
    setAudience(): this {
      return this;
    }
    setExpirationTime(): this {
      return this;
    }
    sign(): Promise<string> {
      return Promise.resolve("signed-service-account-jwt");
    }
  },
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

  it("returns empty metadata and logs the error when the Zitadel call fails", async () => {
    mockEnv.ZITADEL_SERVICE_ACCOUNT_KEY = JSON.stringify({
      type: "serviceaccount",
      keyId: "key-1",
      key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
      userId: "service-user-1",
    });

    const makeRequest = (): Partial<ClientRequest> => ({
      setTimeout: vi.fn() as unknown as ClientRequest["setTimeout"],
      on: vi.fn() as unknown as ClientRequest["on"],
      write: vi.fn() as unknown as ClientRequest["write"],
      end: vi.fn() as unknown as ClientRequest["end"],
    });

    // Issuer discovery may fail independently; getAccessToken deliberately
    // falls back to ZITADEL_ISSUER before exchanging the signed JWT.
    mockHttpRequest.mockImplementationOnce(() => {
      const req = makeRequest();
      req.on = vi.fn((event: string, handler: (err: Error) => void) => {
        if (event === "error")
          queueMicrotask(() => handler(new Error("ECONNRESET")));
        return req as ClientRequest;
      }) as unknown as ClientRequest["on"];
      return req;
    });

    const tokenResponse = new EventEmitter() as EventEmitter & {
      statusCode: number;
    };
    tokenResponse.statusCode = 200;
    mockHttpRequest.mockImplementationOnce(
      (_options: unknown, callback: (res: IncomingMessage) => void) => {
        const req = makeRequest();
        queueMicrotask(() => {
          callback(tokenResponse as IncomingMessage);
          tokenResponse.emit(
            "data",
            Buffer.from(
              JSON.stringify({ access_token: "token", expires_in: 60 }),
            ),
          );
          tokenResponse.emit("end");
        });
        return req;
      },
    );

    const metadataError = new Error("ECONNRESET");
    mockHttpRequest.mockImplementationOnce(() => {
      const req = makeRequest();
      req.on = vi.fn((event: string, handler: (err: Error) => void) => {
        if (event === "error") queueMicrotask(() => handler(metadataError));
        return req as ClientRequest;
      }) as unknown as ClientRequest["on"];
      return req;
    });

    mockLoggerError.mockClear();
    const result = await getOrgMetadataForUser("user-network-error");

    expect(result).toEqual({ managerId: null, department: null, title: null });
    expect(mockLoggerError).toHaveBeenCalledWith(
      { err: metadataError, userId: "user-network-error" },
      "Failed to fetch Zitadel user org metadata",
    );
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
