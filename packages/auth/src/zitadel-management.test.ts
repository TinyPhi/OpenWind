import type { ClientRequest, IncomingMessage } from "node:http";
import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    ZITADEL_ISSUER: "http://localhost:8080",
    ZITADEL_INTROSPECTION_URL: "http://zitadel:8080/oauth/v2/introspect",
    ZITADEL_SERVICE_ACCOUNT_KEY: undefined as string | undefined,
    ZITADEL_PROVISIONING_SERVICE_ACCOUNT_KEY: undefined as string | undefined,
    ZITADEL_PROVISIONING_KEY_JSON: undefined as string | undefined,
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

const {
  listOrgUsers,
  getOrgMetadataForUser,
  parseOrgMetadataEntries,
  parseProvisioningServiceAccountKey,
  createOrg,
  deleteOrg,
  createHumanUser,
} = await import("./zitadel-management.js");

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

describe("parseProvisioningServiceAccountKey", () => {
  it("returns null when neither env var is set", () => {
    mockEnv.ZITADEL_PROVISIONING_SERVICE_ACCOUNT_KEY = undefined;
    mockEnv.ZITADEL_PROVISIONING_KEY_JSON = undefined;
    expect(parseProvisioningServiceAccountKey()).toBeNull();
  });

  it("parses a valid key from the raw JSON env var", () => {
    mockEnv.ZITADEL_PROVISIONING_SERVICE_ACCOUNT_KEY = JSON.stringify({
      type: "serviceaccount",
      keyId: "key-1",
      key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      userId: "sa-provisioning",
    });
    const result = parseProvisioningServiceAccountKey();
    expect(result?.userId).toBe("sa-provisioning");
  });

  it("falls back to the base64-encoded env var when the raw one is absent", () => {
    mockEnv.ZITADEL_PROVISIONING_SERVICE_ACCOUNT_KEY = undefined;
    mockEnv.ZITADEL_PROVISIONING_KEY_JSON = Buffer.from(
      JSON.stringify({
        type: "serviceaccount",
        keyId: "key-2",
        key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
        userId: "sa-provisioning-b64",
      }),
      "utf8",
    ).toString("base64");
    const result = parseProvisioningServiceAccountKey();
    expect(result?.userId).toBe("sa-provisioning-b64");
  });

  it("returns null and logs an error on malformed JSON, never throws", () => {
    mockEnv.ZITADEL_PROVISIONING_SERVICE_ACCOUNT_KEY = "{not valid json";
    expect(parseProvisioningServiceAccountKey()).toBeNull();
    expect(mockLoggerError).toHaveBeenCalled();
  });
});

// ── createOrg / createHumanUser (T7) ────────────────────────────────────────────
// Both exchange the provisioning credential for a token (first mockHttpRequest call),
// then make the actual Management API call (second). mockEnv's provisioning key is set
// here so getProvisioningAccessToken's parse step succeeds.

function queueJsonResponse(status: number, body: unknown): void {
  const response = new EventEmitter() as EventEmitter & { statusCode: number };
  response.statusCode = status;
  mockHttpRequest.mockImplementationOnce(
    (_options: unknown, callback: (res: IncomingMessage) => void) => {
      const req: Partial<ClientRequest> = {
        setTimeout: vi.fn() as unknown as ClientRequest["setTimeout"],
        on: vi.fn() as unknown as ClientRequest["on"],
        write: vi.fn() as unknown as ClientRequest["write"],
        end: vi.fn() as unknown as ClientRequest["end"],
      };
      queueMicrotask(() => {
        callback(response as IncomingMessage);
        response.emit("data", Buffer.from(JSON.stringify(body)));
        response.emit("end");
      });
      return req as ClientRequest;
    },
  );
}

function setProvisioningKey(): void {
  mockEnv.ZITADEL_PROVISIONING_SERVICE_ACCOUNT_KEY = JSON.stringify({
    type: "serviceaccount",
    keyId: "key-provisioning",
    key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    userId: "sa-provisioning",
  });
}

// discoverIssuer() makes its own httpGet call before every token exchange and is never
// left cached-successful by an earlier test in this file (see the getOrgMetadataForUser
// network-error test above) -- queue its failure first so getAccessToken/
// getProvisioningAccessToken fall back to ZITADEL_ISSUER, same pattern as that test.
function queueFailedIssuerDiscovery(): void {
  mockHttpRequest.mockImplementationOnce(() => {
    const req: Partial<ClientRequest> = {
      setTimeout: vi.fn() as unknown as ClientRequest["setTimeout"],
      write: vi.fn() as unknown as ClientRequest["write"],
      end: vi.fn() as unknown as ClientRequest["end"],
      on: vi.fn((event: string, handler: (err: Error) => void) => {
        if (event === "error")
          queueMicrotask(() => handler(new Error("ECONNRESET")));
        return req as ClientRequest;
      }) as unknown as ClientRequest["on"],
    };
    return req as ClientRequest;
  });
}

describe("createOrg", () => {
  it("returns the new org id on success", async () => {
    setProvisioningKey();
    queueFailedIssuerDiscovery();
    queueJsonResponse(200, { access_token: "ptoken", expires_in: 0 });
    queueJsonResponse(200, { organizationId: "org-123" });

    const result = await createOrg("Acme Sandbox");

    expect(result).toEqual({ ok: true, orgId: "org-123" });
  });

  it("reports a conflict (not a generic failure) on a 409 name collision", async () => {
    setProvisioningKey();
    queueFailedIssuerDiscovery();
    queueJsonResponse(200, { access_token: "ptoken", expires_in: 0 });
    queueJsonResponse(409, { message: "already exists" });

    const result = await createOrg("Taken Name");

    expect(result).toEqual({ ok: false, conflict: true });
  });

  it("returns a non-conflict failure when no provisioning credential is configured", async () => {
    mockEnv.ZITADEL_PROVISIONING_SERVICE_ACCOUNT_KEY = undefined;
    mockEnv.ZITADEL_PROVISIONING_KEY_JSON = undefined;

    const result = await createOrg("No Credential Org");

    expect(result).toEqual({ ok: false, conflict: false });
  });

  it("also reports a conflict on Zitadel's own gRPC-gateway AlreadyExists shape (code 6), not just a plain 409", async () => {
    setProvisioningKey();
    queueFailedIssuerDiscovery();
    queueJsonResponse(200, { access_token: "ptoken", expires_in: 0 });
    queueJsonResponse(400, { code: 6, message: "Organisation already exists" });

    const result = await createOrg("Taken Name 2");

    expect(result).toEqual({ ok: false, conflict: true });
  });
});

describe("createHumanUser", () => {
  const input = {
    orgId: "org-123",
    email: "olivia.smith@example.com",
    givenName: "Olivia",
    familyName: "Smith",
    password: "Ow-abc123-9!",
  };

  it("returns the new user id on success", async () => {
    setProvisioningKey();
    queueFailedIssuerDiscovery();
    queueJsonResponse(200, { access_token: "ptoken", expires_in: 0 });
    queueJsonResponse(200, { userId: "user-456" });

    const result = await createHumanUser(input);

    expect(result).toEqual({ ok: true, userId: "user-456" });
  });

  it("reports a conflict (not a generic failure) on a 409 email collision", async () => {
    setProvisioningKey();
    queueFailedIssuerDiscovery();
    queueJsonResponse(200, { access_token: "ptoken", expires_in: 0 });
    queueJsonResponse(409, { message: "already exists" });

    const result = await createHumanUser(input);

    expect(result).toEqual({ ok: false, conflict: true });
  });
});

describe("deleteOrg", () => {
  it("returns true on a successful deletion", async () => {
    setProvisioningKey();
    queueFailedIssuerDiscovery();
    queueJsonResponse(200, { access_token: "ptoken", expires_in: 0 });
    queueJsonResponse(200, { deletionDate: "2023-01-15T01:30:15.01Z" });

    const result = await deleteOrg("org-123");

    expect(result).toBe(true);
  });

  it("returns false on a non-2xx response", async () => {
    setProvisioningKey();
    queueFailedIssuerDiscovery();
    queueJsonResponse(200, { access_token: "ptoken", expires_in: 0 });
    queueJsonResponse(404, { message: "not found" });

    const result = await deleteOrg("org-does-not-exist");

    expect(result).toBe(false);
  });

  it("returns false when no provisioning credential is configured", async () => {
    mockEnv.ZITADEL_PROVISIONING_SERVICE_ACCOUNT_KEY = undefined;
    mockEnv.ZITADEL_PROVISIONING_KEY_JSON = undefined;

    const result = await deleteOrg("org-123");

    expect(result).toBe(false);
  });
});
