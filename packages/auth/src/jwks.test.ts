import { describe, it, expect, vi } from "vitest";

vi.mock("@platform/config", () => ({
  env: {
    ZITADEL_ISSUER: "https://zitadel.example.com",
    ZITADEL_AUDIENCE: "platform-api",
  },
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockCreateRemoteJWKSet = vi.fn(() => ({}));
const mockJwtVerify = vi.fn();
vi.mock("jose", () => ({
  createRemoteJWKSet: (...args: unknown[]) => mockCreateRemoteJWKSet(...args),
  jwtVerify: (...args: unknown[]) => mockJwtVerify(...args),
}));

const { extractAuthContext, verifyJwt } = await import("./jwks.js");
import type { ZitadelClaims } from "./types.js";
import type { JWTPayload } from "jose";

type Claims = JWTPayload & ZitadelClaims;

const BASE_CLAIMS: Claims = {
  sub: "user-123",
  iss: "https://zitadel.example.com",
  aud: ["platform-api"],
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
  email: "alice@example.com",
  "urn:zitadel:iam:user:resourceowner:id": "tenant-abc",
  "urn:zitadel:iam:org:project:roles": {
    agent: { "tenant-abc": "tenant-abc" },
    admin: { "tenant-abc": "tenant-abc" },
  },
};

describe("extractAuthContext", () => {
  it("extracts userId, tenantId, roles and email from valid claims", () => {
    const result = extractAuthContext(BASE_CLAIMS);

    expect(result).not.toBeNull();
    expect(result?.userId).toBe("user-123");
    expect(result?.tenantId).toBe("tenant-abc");
    expect(result?.email).toBe("alice@example.com");
    expect(result?.roles).toContain("agent");
    expect(result?.roles).toContain("admin");
  });

  it("returns null when sub is missing", () => {
    const claims: Claims = { ...BASE_CLAIMS, sub: undefined };
    expect(extractAuthContext(claims)).toBeNull();
  });

  it("returns null when org id claim is missing", () => {
    const claims: Claims = {
      ...BASE_CLAIMS,
      "urn:zitadel:iam:user:resourceowner:id": undefined,
    };
    expect(extractAuthContext(claims)).toBeNull();
  });

  it("returns empty roles array when project roles claim is absent", () => {
    const claims: Claims = {
      ...BASE_CLAIMS,
      "urn:zitadel:iam:org:project:roles": undefined,
    };
    const result = extractAuthContext(claims);
    expect(result?.roles).toEqual([]);
  });

  it("returns empty string for email when claim is absent", () => {
    const claims: Claims = { ...BASE_CLAIMS, email: undefined };
    const result = extractAuthContext(claims);
    expect(result?.email).toBe("");
  });
});

// #3: audience validation must always be enforced (ZITADEL_AUDIENCE is a
// required, non-empty config value — see packages/config/src/env.ts).
describe("verifyJwt", () => {
  it("always passes the configured audience to jose's jwtVerify", async () => {
    mockJwtVerify.mockResolvedValueOnce({ payload: BASE_CLAIMS });

    await verifyJwt("some.jwt.token");

    expect(mockJwtVerify).toHaveBeenCalledWith(
      "some.jwt.token",
      expect.anything(),
      expect.objectContaining({ audience: "platform-api" }),
    );
  });

  it("uses clockTolerance of 5 seconds — not 30 (#255)", async () => {
    mockJwtVerify.mockResolvedValueOnce({ payload: BASE_CLAIMS });

    await verifyJwt("some.jwt.token");

    expect(mockJwtVerify).toHaveBeenCalledWith(
      "some.jwt.token",
      expect.anything(),
      expect.objectContaining({ clockTolerance: 5 }),
    );
  });

  it("returns null when jwtVerify rejects (e.g. audience mismatch)", async () => {
    mockJwtVerify.mockRejectedValueOnce(new Error("audience mismatch"));

    const result = await verifyJwt("some.jwt.token");

    expect(result).toBeNull();
  });
});

describe("getJwks (#262)", () => {
  it("creates the remote JWKS set with a 1-hour cacheMaxAge", async () => {
    mockJwtVerify.mockResolvedValueOnce({ payload: BASE_CLAIMS });
    await verifyJwt("trigger-jwks-init");

    expect(mockCreateRemoteJWKSet).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ cacheMaxAge: 60 * 60 * 1000 }),
    );
  });
});
