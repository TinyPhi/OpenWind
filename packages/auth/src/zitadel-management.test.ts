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
    ZITADEL_PROJECT_ID: undefined as string | undefined,
    ZITADEL_AUDIENCE: "project-777" as string | undefined,
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
  grantProjectToOrg,
  setUserOrgMetadata,
  authorizeUser,
  listUserRolesByUserId,
  getUserById,
  deleteUser,
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
    mockLoggerWarn.mockClear();
    const result = await getOrgMetadataForUser("user-1", "tenant-test-1");

    expect(result).toEqual({ managerId: null, department: null, title: null });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { userId: "user-1", tenantId: "tenant-test-1" },
      "getOrgMetadataForUser: no service account token — check ZITADEL_SERVICE_ACCOUNT_KEY",
    );
  });

  it("omits tenantId from log context when tenantId is not provided (backwards compatibility) (#724)", async () => {
    mockLoggerWarn.mockClear();
    const result = await getOrgMetadataForUser("user-legacy");

    expect(result).toEqual({ managerId: null, department: null, title: null });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { userId: "user-legacy" },
      "getOrgMetadataForUser: no service account token — check ZITADEL_SERVICE_ACCOUNT_KEY",
    );
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

  it("returns empty metadata and logs the error with tenantId when the Zitadel call fails (#724)", async () => {
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
    const result = await getOrgMetadataForUser(
      "user-network-error",
      "tenant-fail",
    );

    expect(result).toEqual({ managerId: null, department: null, title: null });
    expect(mockLoggerError).toHaveBeenCalledWith(
      {
        err: metadataError,
        userId: "user-network-error",
        tenantId: "tenant-fail",
      },
      "Failed to fetch Zitadel user org metadata",
    );
  });
});

describe("getOrgMetadataForUser request", () => {
  it("calls UserService/ListUserMetadata (ListMetadata does not exist and answers 404) and decodes the result", async () => {
    mockEnv.ZITADEL_SERVICE_ACCOUNT_KEY = JSON.stringify({
      type: "serviceaccount",
      keyId: "key-1",
      key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
      userId: "service-user-1",
    });
    const b64 = (v: string): string =>
      Buffer.from(v, "utf8").toString("base64");
    const paths: string[] = [];

    // Answers by path: token exchange, then the metadata call. Anything else (issuer
    // discovery) fails, which getAccessToken tolerates.
    mockHttpRequest.mockImplementation(
      (
        options: { path: string },
        callback: (res: IncomingMessage) => void,
      ): Partial<ClientRequest> => {
        paths.push(options.path);
        const req: Partial<ClientRequest> = {
          setTimeout: vi.fn() as unknown as ClientRequest["setTimeout"],
          on: vi.fn() as unknown as ClientRequest["on"],
          write: vi.fn() as unknown as ClientRequest["write"],
          end: vi.fn() as unknown as ClientRequest["end"],
        };
        const reply = (status: number, body: unknown): void => {
          const res = new EventEmitter() as EventEmitter & {
            statusCode: number;
          };
          res.statusCode = status;
          queueMicrotask(() => {
            callback(res as IncomingMessage);
            res.emit("data", Buffer.from(JSON.stringify(body)));
            res.emit("end");
          });
        };
        if (options.path.includes("/oauth/v2/token")) {
          reply(200, { access_token: "token-endpoint-test", expires_in: 60 });
        } else if (options.path.endsWith("UserService/ListUserMetadata")) {
          reply(200, {
            metadata: [
              { key: "manager_id", value: b64("boss-1") },
              { key: "department", value: b64("sales") },
              { key: "title", value: b64("Sales Executive") },
            ],
          });
        } else {
          reply(404, { message: "not found" });
        }
        return req;
      },
    );

    try {
      const result = await getOrgMetadataForUser("user-endpoint-path");

      expect(result).toEqual({
        managerId: "boss-1",
        department: "sales",
        title: "Sales Executive",
      });
      expect(paths).toContain("/zitadel.user.v2.UserService/ListUserMetadata");
      expect(paths).not.toContain("/zitadel.user.v2.UserService/ListMetadata");
    } finally {
      mockHttpRequest.mockReset();
    }
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

// Like queueJsonResponse, but records the request's path and JSON body so a test can assert
// exactly what was sent to Zitadel.
function queueCapturedJsonResponse(
  status: number,
  body: unknown,
): { path?: string; body?: unknown } {
  const sent: { path?: string; body?: unknown } = {};
  const response = new EventEmitter() as EventEmitter & { statusCode: number };
  response.statusCode = status;
  mockHttpRequest.mockImplementationOnce(
    (options: { path?: string }, callback: (res: IncomingMessage) => void) => {
      sent.path = options.path;
      const req: Partial<ClientRequest> = {
        setTimeout: vi.fn() as unknown as ClientRequest["setTimeout"],
        on: vi.fn() as unknown as ClientRequest["on"],
        write: vi.fn((chunk: string) => {
          sent.body = JSON.parse(chunk) as unknown;
          return true;
        }) as unknown as ClientRequest["write"],
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
  return sent;
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
  it("logs an explicit error and makes no request when the provisioning key isn't configured", async () => {
    mockEnv.ZITADEL_PROVISIONING_SERVICE_ACCOUNT_KEY = undefined;
    mockEnv.ZITADEL_PROVISIONING_KEY_JSON = undefined;
    mockLoggerError.mockClear();
    mockHttpRequest.mockClear();

    const result = await createOrg("Acme Sandbox");

    expect(result).toEqual({ ok: false, conflict: false });
    expect(mockHttpRequest).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      {},
      expect.stringContaining("ZITADEL_PROVISIONING_KEY_JSON"),
    );
  });

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

describe("createHumanUser username", () => {
  const base = {
    orgId: "org-123",
    email: "olivia.smith@example.com",
    givenName: "Olivia",
    familyName: "Smith",
    password: "Ow-abc123-9!",
  };

  it("sends the username when one is given", async () => {
    setProvisioningKey();
    queueFailedIssuerDiscovery();
    queueJsonResponse(200, { access_token: "ptoken", expires_in: 0 });
    const sent = queueCapturedJsonResponse(200, { userId: "user-1" });

    await createHumanUser({ ...base, username: "olivia.smith" });

    expect((sent.body as { username?: string }).username).toBe("olivia.smith");
  });

  it("omits the username otherwise, so Zitadel keeps using the email", async () => {
    setProvisioningKey();
    queueFailedIssuerDiscovery();
    queueJsonResponse(200, { access_token: "ptoken", expires_in: 0 });
    const sent = queueCapturedJsonResponse(200, { userId: "user-2" });

    await createHumanUser(base);

    expect(sent.body).not.toHaveProperty("username");
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

// ── Sandbox sign-in: project grant + role authorizations ────────────────────────

describe("grantProjectToOrg", () => {
  it("grants the OpenWind project to the org with admin, agent and user roles", async () => {
    setProvisioningKey();
    queueFailedIssuerDiscovery();
    queueJsonResponse(200, { access_token: "ptoken", expires_in: 0 });
    const sent = queueCapturedJsonResponse(200, {
      creationDate: "2026-10-13T00:00:00Z",
    });

    await expect(grantProjectToOrg("org-sbx")).resolves.toBe(true);

    expect(sent.path).toBe(
      "/zitadel.project.v2.ProjectService/CreateProjectGrant",
    );
    expect(sent.body).toEqual({
      projectId: "project-777",
      grantedOrganizationId: "org-sbx",
      roleKeys: ["admin", "agent", "user"],
    });
  });

  it("treats an already-existing grant as success (a retried provisioning step)", async () => {
    setProvisioningKey();
    queueFailedIssuerDiscovery();
    queueJsonResponse(200, { access_token: "ptoken", expires_in: 0 });
    queueJsonResponse(409, { code: 6, message: "AlreadyExists" });

    await expect(grantProjectToOrg("org-sbx")).resolves.toBe(true);
  });

  it("returns false and logs (without the body) when Zitadel refuses", async () => {
    setProvisioningKey();
    queueFailedIssuerDiscovery();
    queueJsonResponse(200, { access_token: "ptoken", expires_in: 0 });
    queueJsonResponse(403, { message: "permission denied" });

    await expect(grantProjectToOrg("org-sbx")).resolves.toBe(false);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ status: 403, orgId: "org-sbx" }),
      expect.stringContaining("project grant failed"),
    );
  });
});

describe("setUserOrgMetadata", () => {
  const b64 = (v: string): string => Buffer.from(v, "utf8").toString("base64");

  it("writes the org keys it is given as base64 and skips undefined or empty values", async () => {
    setProvisioningKey();
    queueFailedIssuerDiscovery();
    queueJsonResponse(200, { access_token: "ptoken", expires_in: 0 });
    const sent = queueCapturedJsonResponse(200, {});

    await expect(
      setUserOrgMetadata("user-9", {
        department: "sales",
        title: "Sales Executive",
        managerId: undefined,
      }),
    ).resolves.toBe(true);

    expect(sent.path).toBe("/zitadel.user.v2.UserService/SetUserMetadata");
    expect(sent.body).toEqual({
      userId: "user-9",
      metadata: [
        { key: "department", value: b64("sales") },
        { key: "title", value: b64("Sales Executive") },
      ],
    });
  });

  it("removes the manager when managerId is an explicit null, so a re-seed clears a stale one", async () => {
    setProvisioningKey();
    queueFailedIssuerDiscovery();
    queueJsonResponse(200, { access_token: "ptoken", expires_in: 0 });
    const set = queueCapturedJsonResponse(200, {});
    queueFailedIssuerDiscovery();
    queueJsonResponse(200, { access_token: "ptoken", expires_in: 0 });
    const del = queueCapturedJsonResponse(200, {});

    await expect(
      setUserOrgMetadata("user-9", {
        managerId: null,
        department: "sales",
        title: "Sales Manager",
      }),
    ).resolves.toBe(true);

    expect(set.path).toBe("/zitadel.user.v2.UserService/SetUserMetadata");
    expect(del.path).toBe("/zitadel.user.v2.UserService/DeleteUserMetadata");
    expect(del.body).toEqual({ userId: "user-9", keys: ["manager_id"] });
  });

  it("treats a missing manager key (404 on delete) as already cleared", async () => {
    setProvisioningKey();
    queueFailedIssuerDiscovery();
    queueJsonResponse(200, { access_token: "ptoken", expires_in: 0 });
    queueJsonResponse(404, { message: "metadata not found" });

    mockLoggerWarn.mockClear();

    await expect(
      setUserOrgMetadata("user-9", { managerId: null }),
    ).resolves.toBe(true);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 404, userId: "user-9" }),
      expect.stringContaining("already done"),
    );
  });

  it("reports failure when Zitadel refuses the manager removal", async () => {
    setProvisioningKey();
    queueFailedIssuerDiscovery();
    queueJsonResponse(200, { access_token: "ptoken", expires_in: 0 });
    queueJsonResponse(403, { message: "permission denied" });

    await expect(
      setUserOrgMetadata("user-9", { managerId: null }),
    ).resolves.toBe(false);
  });

  it("makes no request when there is nothing to write or clear", async () => {
    mockHttpRequest.mockClear();

    await expect(
      setUserOrgMetadata("user-9", { managerId: undefined, department: "" }),
    ).resolves.toBe(true);

    expect(mockHttpRequest).not.toHaveBeenCalled();
  });

  it("drops the cached metadata so the next read after a write sees the new values", async () => {
    mockEnv.ZITADEL_SERVICE_ACCOUNT_KEY = JSON.stringify({
      type: "serviceaccount",
      keyId: "key-1",
      key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
      userId: "service-user-1",
    });
    setProvisioningKey();
    let department = "old-department";
    const reads: string[] = [];

    mockHttpRequest.mockImplementation(
      (
        options: { path: string },
        callback: (res: IncomingMessage) => void,
      ): Partial<ClientRequest> => {
        const req: Partial<ClientRequest> = {
          setTimeout: vi.fn() as unknown as ClientRequest["setTimeout"],
          on: vi.fn() as unknown as ClientRequest["on"],
          write: vi.fn() as unknown as ClientRequest["write"],
          end: vi.fn() as unknown as ClientRequest["end"],
        };
        const reply = (status: number, body: unknown): void => {
          const res = new EventEmitter() as EventEmitter & {
            statusCode: number;
          };
          res.statusCode = status;
          queueMicrotask(() => {
            callback(res as IncomingMessage);
            res.emit("data", Buffer.from(JSON.stringify(body)));
            res.emit("end");
          });
        };
        if (options.path.includes("/oauth/v2/token")) {
          reply(200, { access_token: "tok", expires_in: 0 });
        } else if (options.path.endsWith("UserService/SetUserMetadata")) {
          department = "new-department";
          reply(200, {});
        } else if (/UserService[/]List(User)?Metadata$/.test(options.path)) {
          reads.push(department);
          reply(200, {
            metadata: [{ key: "department", value: b64(department) }],
          });
        } else {
          reply(404, {});
        }
        return req;
      },
    );

    try {
      const before = await getOrgMetadataForUser("user-cache-evict");
      await setUserOrgMetadata("user-cache-evict", {
        department: "new-department",
      });
      const after = await getOrgMetadataForUser("user-cache-evict");

      expect(before.department).toBe("old-department");
      expect(after.department).toBe("new-department");
      expect(reads).toEqual(["old-department", "new-department"]);
    } finally {
      mockHttpRequest.mockReset();
    }
  });
});

describe("authorizeUser", () => {
  it("authorizes the user on the project through their org's grant", async () => {
    setProvisioningKey();
    queueFailedIssuerDiscovery();
    queueJsonResponse(200, { access_token: "ptoken", expires_in: 0 });
    const sent = queueCapturedJsonResponse(200, { id: "authz-1" });

    await expect(authorizeUser("user-1", "org-sbx", ["admin"])).resolves.toBe(
      true,
    );

    expect(sent.path).toBe(
      "/zitadel.authorization.v2.AuthorizationService/CreateAuthorization",
    );
    expect(sent.body).toEqual({
      userId: "user-1",
      projectId: "project-777",
      organizationId: "org-sbx",
      roleKeys: ["admin"],
    });
  });

  // Runs with the IAM_ORG_MANAGER provisioning credential: it must never hand out a role
  // outside the sandbox allowlist, whatever a caller passes.
  it.each([["superadmin"], ["platform_admin"], []])(
    "refuses role keys %j without calling Zitadel",
    async (...roleKeys: string[]) => {
      mockHttpRequest.mockClear();
      setProvisioningKey();

      await expect(
        authorizeUser(
          "user-1",
          "org-sbx",
          // Deliberately outside the typed allowlist to prove the runtime check.
          roleKeys as unknown as ("admin" | "agent" | "user")[],
        ),
      ).resolves.toBe(false);
      expect(mockHttpRequest).not.toHaveBeenCalled();
    },
  );

  it("returns false when Zitadel rejects the authorization", async () => {
    setProvisioningKey();
    queueFailedIssuerDiscovery();
    queueJsonResponse(200, { access_token: "ptoken", expires_in: 0 });
    queueJsonResponse(400, { message: "bad request" });

    await expect(authorizeUser("user-1", "org-sbx", ["user"])).resolves.toBe(
      false,
    );
  });
});

describe("listUserRolesByUserId", () => {
  // The v1 grant search defaults to the caller's own org; a sandbox org's users came back
  // role-less (and the Users page empty) until the search was scoped to the requested org.
  it("scopes the user-grant search to the requested org", async () => {
    mockEnv.ZITADEL_SERVICE_ACCOUNT_KEY = JSON.stringify({
      type: "serviceaccount",
      keyId: "key-1",
      key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
      userId: "service-user-1",
    });
    let grantSearchHeaders: Record<string, string> | undefined;
    mockHttpRequest.mockImplementation(
      (
        options: { path?: string; headers?: Record<string, string> },
        callback?: (res: IncomingMessage) => void,
      ) => {
        const req: Partial<ClientRequest> = {
          setTimeout: vi.fn() as unknown as ClientRequest["setTimeout"],
          on: vi.fn() as unknown as ClientRequest["on"],
          write: vi.fn() as unknown as ClientRequest["write"],
          end: vi.fn() as unknown as ClientRequest["end"],
        };
        const path = options.path ?? "";
        let body: unknown = {};
        if (path.includes("/oauth/v2/token")) {
          body = { access_token: "read-token", expires_in: 60 };
        } else if (path.includes("/users/grants/_search")) {
          grantSearchHeaders = options.headers;
          body = {
            result: [{ userId: "sbx-user-1", roleKeys: ["user"] }],
          };
        }
        const response = new EventEmitter() as EventEmitter & {
          statusCode: number;
        };
        response.statusCode = 200;
        queueMicrotask(() => {
          callback?.(response as IncomingMessage);
          response.emit("data", Buffer.from(JSON.stringify(body)));
          response.emit("end");
        });
        return req as ClientRequest;
      },
    );
    try {
      const roles = await listUserRolesByUserId("sandbox-org-42");

      expect(grantSearchHeaders?.["x-zitadel-orgid"]).toBe("sandbox-org-42");
      expect(roles.get("sbx-user-1")).toEqual(["user"]);
    } finally {
      mockHttpRequest.mockReset();
    }
  });
});

describe("getUserById", () => {
  // A fake Zitadel: the token exchange always works; GetUserByID answers from this object.
  const zitadel = { status: 200, email: "old@example.com", calls: 0 };
  function serveZitadel(): void {
    mockEnv.ZITADEL_SERVICE_ACCOUNT_KEY = JSON.stringify({
      type: "serviceaccount",
      keyId: "key-1",
      key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
      userId: "service-user-1",
    });
    mockHttpRequest.mockImplementation(
      (
        options: { path?: string },
        callback?: (res: IncomingMessage) => void,
      ) => {
        const req: Partial<ClientRequest> = {
          setTimeout: vi.fn() as unknown as ClientRequest["setTimeout"],
          on: vi.fn() as unknown as ClientRequest["on"],
          write: vi.fn() as unknown as ClientRequest["write"],
          end: vi.fn() as unknown as ClientRequest["end"],
        };
        const path = options.path ?? "";
        let status = 200;
        let body: unknown = {};
        if (path.includes("/oauth/v2/token")) {
          body = { access_token: "read-token", expires_in: 60 };
        } else if (path.includes("GetUserByID")) {
          zitadel.calls++;
          status = zitadel.status;
          body = {
            user: { userId: "u-1", human: { email: { email: zitadel.email } } },
          };
        }
        const response = new EventEmitter() as EventEmitter & {
          statusCode: number;
        };
        response.statusCode = status;
        queueMicrotask(() => {
          callback?.(response as IncomingMessage);
          response.emit("data", Buffer.from(JSON.stringify(body)));
          response.emit("end");
        });
        return req as ClientRequest;
      },
    );
  }

  it("serves a cached address normally, but fresh:true reads the latest one from Zitadel", async () => {
    serveZitadel();
    zitadel.email = "old@example.com";
    try {
      expect((await getUserById("u-1"))?.email).toBe("old@example.com");
      zitadel.email = "new@example.com"; // changed in Zitadel
      const callsBefore = zitadel.calls;

      expect((await getUserById("u-1"))?.email).toBe("old@example.com");
      expect(zitadel.calls).toBe(callsBefore); // served from cache

      expect((await getUserById("u-1", { fresh: true }))?.email).toBe(
        "new@example.com",
      );
      // The fresh read refreshed the cache for everyone else too.
      expect((await getUserById("u-1"))?.email).toBe("new@example.com");
    } finally {
      mockHttpRequest.mockReset();
    }
  });

  it("does not fall back to the cache when Zitadel says the user is gone (4xx)", async () => {
    serveZitadel();
    zitadel.status = 200;
    zitadel.email = "deleted.user@example.com";
    try {
      await getUserById("u-1", { fresh: true }); // cached
      zitadel.status = 404; // user deleted in Zitadel

      expect(await getUserById("u-1", { fresh: true })).toBeNull();
    } finally {
      zitadel.status = 200;
      mockHttpRequest.mockReset();
    }
  });

  it("falls back to the cached user when a fresh lookup can't reach Zitadel", async () => {
    serveZitadel();
    zitadel.status = 200;
    zitadel.email = "cached@example.com";
    try {
      await getUserById("u-1", { fresh: true }); // caches cached@example.com
      zitadel.status = 503;

      expect((await getUserById("u-1", { fresh: true }))?.email).toBe(
        "cached@example.com",
      );
    } finally {
      zitadel.status = 200;
      mockHttpRequest.mockReset();
    }
  });

  it("treats a 429 like an outage: serves the cached user instead of reporting them gone", async () => {
    serveZitadel();
    zitadel.status = 200;
    zitadel.email = "limited@example.com";
    try {
      await getUserById("u-1", { fresh: true });
      zitadel.status = 429;

      expect((await getUserById("u-1", { fresh: true }))?.email).toBe(
        "limited@example.com",
      );
    } finally {
      zitadel.status = 200;
      mockHttpRequest.mockReset();
    }
  });
});

describe("listOrgUsers pagination", () => {
  function human(i: number): Record<string, unknown> {
    return {
      userId: `u-${i}`,
      state: "USER_STATE_ACTIVE",
      human: { email: { email: `u${i}@example.com` } },
    };
  }

  it("fetches every page of a large org, so members past the first 500 are kept", async () => {
    mockEnv.ZITADEL_SERVICE_ACCOUNT_KEY = JSON.stringify({
      type: "serviceaccount",
      keyId: "key-1",
      key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
      userId: "service-user-1",
    });
    const total = 1200;
    const offsets: string[] = [];
    mockHttpRequest.mockImplementation(
      (
        options: { path?: string },
        callback?: (res: IncomingMessage) => void,
      ) => {
        let written = "";
        const req: Partial<ClientRequest> = {
          setTimeout: vi.fn() as unknown as ClientRequest["setTimeout"],
          on: vi.fn() as unknown as ClientRequest["on"],
          write: ((chunk: string) => {
            written += chunk;
            return true;
          }) as unknown as ClientRequest["write"],
          end: (() => {
            let body: unknown = {};
            if (options.path?.includes("/oauth/v2/token")) {
              body = { access_token: "read-token", expires_in: 60 };
            } else if (options.path?.includes("ListUsers")) {
              const offset = Number(
                (JSON.parse(written) as { query: { offset?: string } }).query
                  .offset ?? "0",
              );
              offsets.push(String(offset));
              const count = Math.min(500, total - offset);
              body = {
                result: Array.from({ length: count }, (_, i) =>
                  human(offset + i),
                ),
                details: { totalResult: String(total) },
              };
            }
            const response = new EventEmitter() as EventEmitter & {
              statusCode: number;
            };
            response.statusCode = 200;
            queueMicrotask(() => {
              callback?.(response as IncomingMessage);
              response.emit("data", Buffer.from(JSON.stringify(body)));
              response.emit("end");
            });
          }) as unknown as ClientRequest["end"],
        };
        return req as ClientRequest;
      },
    );
    try {
      const users = await listOrgUsers("org-large-952");

      expect(users).toHaveLength(total);
      expect(offsets).toEqual(["0", "500", "1000"]);
      expect(users.some((u) => u.userId === "u-1199")).toBe(true);
    } finally {
      mockHttpRequest.mockReset();
    }
  });

  it("does not keep an empty result cached after a failed fetch, so the next call retries", async () => {
    mockEnv.ZITADEL_SERVICE_ACCOUNT_KEY = JSON.stringify({
      type: "serviceaccount",
      keyId: "key-1",
      key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
      userId: "service-user-1",
    });
    let listStatus = 429;
    let listCalls = 0;
    mockHttpRequest.mockImplementation(
      (
        options: { path?: string },
        callback?: (res: IncomingMessage) => void,
      ) => {
        const req: Partial<ClientRequest> = {
          setTimeout: vi.fn() as unknown as ClientRequest["setTimeout"],
          on: vi.fn() as unknown as ClientRequest["on"],
          write: vi.fn() as unknown as ClientRequest["write"],
          end: (() => {
            let status = 200;
            let body: unknown = {};
            if (options.path?.includes("/oauth/v2/token")) {
              body = { access_token: "read-token", expires_in: 60 };
            } else if (options.path?.includes("ListUsers")) {
              listCalls++;
              status = listStatus;
              body = { result: [human(1)], details: { totalResult: "1" } };
            }
            const response = new EventEmitter() as EventEmitter & {
              statusCode: number;
            };
            response.statusCode = status;
            queueMicrotask(() => {
              callback?.(response as IncomingMessage);
              response.emit("data", Buffer.from(JSON.stringify(body)));
              response.emit("end");
            });
          }) as unknown as ClientRequest["end"],
        };
        return req as ClientRequest;
      },
    );
    try {
      expect(await listOrgUsers("org-evict-952")).toEqual([]);
      listStatus = 200;

      const users = await listOrgUsers("org-evict-952");

      expect(users.map((u) => u.userId)).toEqual(["u-1"]);
      expect(listCalls).toBe(2);
    } finally {
      mockHttpRequest.mockReset();
    }
  });
});

describe("deleteUser", () => {
  // A fake Zitadel: the token exchange always works; DeleteUser answers with `deleteStatus`.
  let deleteStatus = 200;
  function serveZitadel(): void {
    mockEnv.ZITADEL_SERVICE_ACCOUNT_KEY = JSON.stringify({
      type: "serviceaccount",
      keyId: "key-1",
      key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
      userId: "service-user-1",
    });
    mockHttpRequest.mockImplementation(
      (
        options: { path?: string },
        callback?: (res: IncomingMessage) => void,
      ) => {
        const req: Partial<ClientRequest> = {
          setTimeout: vi.fn() as unknown as ClientRequest["setTimeout"],
          on: vi.fn() as unknown as ClientRequest["on"],
          write: vi.fn() as unknown as ClientRequest["write"],
          end: vi.fn() as unknown as ClientRequest["end"],
        };
        const path = options.path ?? "";
        let status = 200;
        let body: unknown = {};
        if (path.includes("/oauth/v2/token")) {
          body = { access_token: "delete-token", expires_in: 60 };
        } else if (path.includes("DeleteUser")) {
          status = deleteStatus;
        }
        const response = new EventEmitter() as EventEmitter & {
          statusCode: number;
        };
        response.statusCode = status;
        queueMicrotask(() => {
          callback?.(response as IncomingMessage);
          response.emit("data", Buffer.from(JSON.stringify(body)));
          response.emit("end");
        });
        return req as ClientRequest;
      },
    );
  }

  it.each([
    [200, true],
    [404, true],
    [500, false],
    [403, false],
  ])(
    "Zitadel answering %i means the login is gone: %s",
    async (status, gone) => {
      serveZitadel();
      deleteStatus = status;
      try {
        expect(await deleteUser("u-1")).toBe(gone);
      } finally {
        mockHttpRequest.mockReset();
      }
    },
  );
});
