import { describe, it, expect } from "vitest";
import {
  computeApiKeyStatus,
  computeExpiryBadge,
  summarizeScopes,
  type ApiKeyRow,
} from "./status.js";

function makeKey(overrides: Partial<ApiKeyRow> = {}): ApiKeyRow {
  return {
    id: "key-1",
    name: "test",
    scopes: ["entity:ticket:read"],
    scopesFormat: "action",
    applicationName: "Acme",
    applicationDescription: null,
    applicationContactEmail: null,
    rotatedFrom: null,
    createdAt: "2026-01-01T00:00:00Z",
    createdBy: "u-1",
    expiresAt: "2027-01-01T00:00:00Z",
    revokedAt: null,
    ...overrides,
  };
}

describe("computeApiKeyStatus (ADR-012 Phase A spec R10)", () => {
  it("returns revoked when revokedAt is set, regardless of expiry", () => {
    const key = makeKey({
      revokedAt: "2026-05-01T00:00:00Z",
      expiresAt: "2027-01-01T00:00:00Z",
    });
    expect(computeApiKeyStatus(key, [key])).toBe("revoked");
  });

  it("returns expired when past expiresAt and not revoked", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const key = makeKey({ expiresAt: "2026-01-01T00:00:00Z" });
    expect(computeApiKeyStatus(key, [key], now)).toBe("expired");
  });

  it("returns active for a live key with no live successor", () => {
    const now = new Date("2026-01-15T00:00:00Z");
    const key = makeKey();
    expect(computeApiKeyStatus(key, [key], now)).toBe("active");
  });

  it("returns rotating for a live predecessor with a live successor pointing rotatedFrom at it", () => {
    const now = new Date("2026-01-15T00:00:00Z");
    const predecessor = makeKey({ id: "pred-1" });
    const successor = makeKey({
      id: "succ-1",
      rotatedFrom: "pred-1",
      expiresAt: "2028-01-01T00:00:00Z",
    });
    expect(
      computeApiKeyStatus(predecessor, [predecessor, successor], now),
    ).toBe("rotating");
    // the successor itself is simply active, not "rotating" — spec R3
    expect(computeApiKeyStatus(successor, [predecessor, successor], now)).toBe(
      "active",
    );
  });

  it("does not report rotating if the successor is itself already revoked", () => {
    const now = new Date("2026-01-15T00:00:00Z");
    const predecessor = makeKey({ id: "pred-1" });
    const revokedSuccessor = makeKey({
      id: "succ-1",
      rotatedFrom: "pred-1",
      revokedAt: "2026-01-10T00:00:00Z",
    });
    expect(
      computeApiKeyStatus(predecessor, [predecessor, revokedSuccessor], now),
    ).toBe("active");
  });
});

describe("computeExpiryBadge (ADR-012 Phase A spec R10)", () => {
  it("returns 'none' when more than 30 days remain", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const badge = computeExpiryBadge("2026-03-01T00:00:00Z", now);
    expect(badge.level).toBe("none");
  });

  it("returns amber within 30 days of expiry", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const badge = computeExpiryBadge("2026-01-20T00:00:00Z", now);
    expect(badge.level).toBe("amber");
    expect(badge.label).toMatch(/Expires in \d+ days?/);
  });

  it("returns red once past expiry", () => {
    const now = new Date("2026-01-20T00:00:00Z");
    const badge = computeExpiryBadge("2026-01-01T00:00:00Z", now);
    expect(badge.level).toBe("red");
    expect(badge.label).toBe("Expired");
  });

  it("returns 'none' for a null (never-expiring) key", () => {
    const badge = computeExpiryBadge(null);
    expect(badge.level).toBe("none");
  });
});

describe("summarizeScopes (ADR-012 Phase A spec R8)", () => {
  it("labels the exact read-only preset scope set as 'Read-only'", () => {
    expect(summarizeScopes(["entity:ticket:read"], "action")).toBe("Read-only");
  });

  it("labels the exact read-write preset scope set as 'Read-write'", () => {
    expect(
      summarizeScopes(
        [
          "entity:ticket:create",
          "entity:ticket:read",
          "entity:ticket:comment",
          "entity:ticket:transition",
          "entity:ticket:subticket",
          "entity:ticket:attach",
        ],
        "action",
      ),
    ).toBe("Read-write");
  });

  it("labels a non-preset scope combination as Custom with a count", () => {
    expect(
      summarizeScopes(
        ["entity:ticket:read", "entity:ticket:comment"],
        "action",
      ),
    ).toBe("Custom (2 scopes)");
  });

  it("joins role-format scopes verbatim, never a preset label", () => {
    expect(summarizeScopes(["admin"], "role")).toBe("admin");
  });
});
