import { describe, it, expect, vi } from "vitest";

vi.mock("ioredis", () => ({ default: vi.fn() }));
vi.mock("@platform/config", () => ({
  env: { REDIS_URL: "redis://localhost:6379", NODE_ENV: "test" },
}));
vi.mock("@platform/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const {
  resolveSupersetErasureMode,
  parseSupersetSelfcheck,
  SUPERSET_SELFCHECK_TTL_SECONDS,
} = await import("./superset-selfcheck.js");

const NOW = 1_800_000_000_000;
const check = (
  stage2: boolean | null,
  ageMs = 1000,
  outcome: "ok" | "mismatch" | "unreachable" = "ok",
) => ({
  checkedAt: NOW - ageMs,
  outcome,
  stage2,
  mismatch: false,
});

describe("resolveSupersetErasureMode (#1137, fail closed)", () => {
  it("overrides a local cache-only or off when Superset reports Stage 2 on", () => {
    for (const local of ["cache-only", "off"] as const) {
      expect(resolveSupersetErasureMode(local, check(true), NOW)).toEqual({
        mode: "full",
        verified: true,
        overridden: true,
      });
    }
  });

  it("keeps local full and does not call it an override", () => {
    expect(resolveSupersetErasureMode("full", check(true), NOW)).toEqual({
      mode: "full",
      verified: true,
      overridden: false,
    });
  });

  it("keeps local full when the check is missing, stale or says Stage 2 is off", () => {
    for (const c of [
      null,
      check(null),
      check(false),
      check(true, 31 * 60_000),
    ]) {
      expect(resolveSupersetErasureMode("full", c, NOW).mode).toBe("full");
    }
  });

  it("verifies cache-only only with a fresh answer that Stage 2 is off", () => {
    expect(resolveSupersetErasureMode("cache-only", check(false), NOW)).toEqual(
      { mode: "cache-only", verified: true, overridden: false },
    );
  });

  it("leaves cache-only unverified when there is no fresh answer", () => {
    const stale = check(false, (SUPERSET_SELFCHECK_TTL_SECONDS + 1) * 1000);
    const future = check(false, -10 * 60_000);
    for (const c of [null, check(null, 1000, "unreachable"), stale, future]) {
      expect(resolveSupersetErasureMode("cache-only", c, NOW).verified).toBe(
        false,
      );
    }
  });

  it("a stale Stage 2 on is not trusted but cache-only stays unverified, never verified-off", () => {
    const r = resolveSupersetErasureMode(
      "cache-only",
      check(true, 31 * 60_000),
      NOW,
    );
    expect(r).toEqual({
      mode: "cache-only",
      verified: false,
      overridden: false,
    });
  });

  it("keeps an operator's off", () => {
    expect(resolveSupersetErasureMode("off", null, NOW)).toEqual({
      mode: "off",
      verified: true,
      overridden: false,
    });
  });
});

describe("parseSupersetSelfcheck", () => {
  it("round-trips a well-formed result", () => {
    const c = check(true);
    expect(parseSupersetSelfcheck(JSON.stringify(c))).toEqual(c);
  });

  it.each([
    null,
    "",
    "not json",
    "[]",
    "null",
    JSON.stringify({
      checkedAt: "x",
      outcome: "ok",
      stage2: true,
      mismatch: false,
    }),
    JSON.stringify({
      checkedAt: 1,
      outcome: "bogus",
      stage2: true,
      mismatch: false,
    }),
    JSON.stringify({
      checkedAt: 1,
      outcome: "ok",
      stage2: "yes",
      mismatch: false,
    }),
    JSON.stringify({ checkedAt: 1, outcome: "ok", stage2: true }),
  ])("treats %j as no result", (raw) => {
    expect(parseSupersetSelfcheck(raw)).toBeNull();
  });
});
