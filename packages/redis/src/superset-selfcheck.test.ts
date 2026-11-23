import { describe, it, expect, vi } from "vitest";

vi.mock("ioredis", () => ({
  default: vi.fn().mockImplementation(function () {
    return {
      on: vi.fn(),
      set: vi.fn(),
      get: vi.fn(),
      multi: vi.fn(),
    };
  }),
}));
vi.mock("@platform/config", () => ({
  env: {
    REDIS_URL: "redis://localhost:6379",
    NODE_ENV: "test",
    SUPERSET_SELFCHECK_TTL_MINUTES: 30,
  },
}));
vi.mock("@platform/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const {
  resolveSupersetErasureMode,
  parseSupersetSelfcheck,
  supersetSelfcheckTtlSeconds,
  writeSupersetUnreconciled,
  readSupersetUnreconciledCount,
  readSupersetUnreconciledEntries,
  SUPERSET_UNRECONCILED_KEY,
  SUPERSET_UNRECONCILED_ENTRIES_KEY,
  SUPERSET_UNRECONCILED_TTL_SECONDS,
  SUPERSET_UNRECONCILED_ENTRY_CAP,
} = await import("./superset-selfcheck.js");

const { env } = (await import("@platform/config")) as unknown as {
  env: { SUPERSET_SELFCHECK_TTL_MINUTES: number };
};

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

  it("honours SUPERSET_SELFCHECK_TTL_MINUTES", () => {
    env.SUPERSET_SELFCHECK_TTL_MINUTES = 60;
    try {
      expect(supersetSelfcheckTtlSeconds()).toBe(3600);
      expect(
        resolveSupersetErasureMode("cache-only", check(false, 45 * 60_000), NOW)
          .verified,
      ).toBe(true);
    } finally {
      env.SUPERSET_SELFCHECK_TTL_MINUTES = 30;
    }
    expect(
      resolveSupersetErasureMode("cache-only", check(false, 45 * 60_000), NOW)
        .verified,
    ).toBe(false);
  });

  it("leaves cache-only unverified when there is no fresh answer", () => {
    const stale = check(false, (supersetSelfcheckTtlSeconds() + 1) * 1000);
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

/** A MULTI that records its queued SETs, so a test can assert what was written and that it was one transaction. */
function fakeMulti(results?: [Error | null, unknown][] | null) {
  const sets: unknown[][] = [];
  const pipeline = {
    set: vi.fn((...args: unknown[]) => {
      sets.push(args);
      return pipeline;
    }),
    exec: vi.fn(async () =>
      results === undefined ? sets.map(() => [null, "OK"]) : results,
    ),
  };
  return { pipeline, sets };
}

const entry = (tenantId: string, subjectHash: string, createdAt: number) => ({
  tenantId,
  subjectHash,
  createdAt,
});

describe("unreconciled snapshot in Redis (#1138, #1141)", () => {
  it("writes the count and the entries in one MULTI, oldest first", async () => {
    const { getRedis } = await import("./index.js");
    const client = getRedis();
    const { pipeline, sets } = fakeMulti();
    client.multi = vi.fn().mockReturnValue(pipeline) as never;

    const young = entry("t1", "young", 2_000);
    const old = entry("t2", "old", 1_000);
    await writeSupersetUnreconciled(2, [young, old]);

    expect(client.multi).toHaveBeenCalledTimes(1);
    expect(pipeline.exec).toHaveBeenCalledTimes(1);
    expect(sets).toEqual([
      [SUPERSET_UNRECONCILED_KEY, "2", "EX", SUPERSET_UNRECONCILED_TTL_SECONDS],
      [
        SUPERSET_UNRECONCILED_ENTRIES_KEY,
        JSON.stringify([old, young]),
        "EX",
        SUPERSET_UNRECONCILED_TTL_SECONDS,
      ],
    ]);
  });

  it("keeps the true count but caps the entries at the oldest N", async () => {
    const { getRedis } = await import("./index.js");
    const client = getRedis();
    const { pipeline, sets } = fakeMulti();
    client.multi = vi.fn().mockReturnValue(pipeline) as never;

    const total = SUPERSET_UNRECONCILED_ENTRY_CAP + 25;
    const many = Array.from({ length: total }, (_, i) =>
      entry("t1", `h${i}`, 10_000 - i),
    );
    await writeSupersetUnreconciled(total, many);

    expect(sets[0]?.[1]).toBe(String(total));
    const stored = JSON.parse(String(sets[1]?.[1])) as { createdAt: number }[];
    expect(stored).toHaveLength(SUPERSET_UNRECONCILED_ENTRY_CAP);
    expect(stored[0]?.createdAt).toBe(10_000 - (total - 1));
    expect(stored.at(-1)?.createdAt).toBe(
      10_000 - (total - SUPERSET_UNRECONCILED_ENTRY_CAP),
    );
  });

  it("lists a subject once, with its oldest row", async () => {
    const { getRedis } = await import("./index.js");
    const client = getRedis();
    const { pipeline, sets } = fakeMulti();
    client.multi = vi.fn().mockReturnValue(pipeline) as never;

    await writeSupersetUnreconciled(1, [
      entry("t1", "same", 5_000),
      entry("t1", "same", 1_000),
      entry("t2", "same", 3_000),
    ]);
    const stored = JSON.parse(String(sets[1]?.[1])) as {
      tenantId: string;
      createdAt: number;
    }[];
    expect(stored).toEqual([
      entry("t1", "same", 1_000),
      entry("t2", "same", 3_000),
    ]);
  });

  it("writes an empty snapshot", async () => {
    const { getRedis } = await import("./index.js");
    const client = getRedis();
    const { pipeline, sets } = fakeMulti();
    client.multi = vi.fn().mockReturnValue(pipeline) as never;

    await writeSupersetUnreconciled(0, []);
    expect(sets[0]?.[1]).toBe("0");
    expect(sets[1]?.[1]).toBe("[]");
  });

  it("throws when the MULTI fails or one of its commands errors", async () => {
    const { getRedis } = await import("./index.js");
    const client = getRedis();

    client.multi = vi.fn().mockReturnValue(fakeMulti(null).pipeline) as never;
    const aborted = fakeMulti();
    aborted.pipeline.exec.mockResolvedValue(null);
    client.multi = vi.fn().mockReturnValue(aborted.pipeline) as never;
    await expect(writeSupersetUnreconciled(1, [])).rejects.toThrow(
      /could not be written/,
    );

    const partial = fakeMulti([
      [null, "OK"],
      [new Error("OOM"), null],
    ]);
    client.multi = vi.fn().mockReturnValue(partial.pipeline) as never;
    await expect(writeSupersetUnreconciled(1, [])).rejects.toThrow(
      /could not be written/,
    );
  });

  it("reads the count back", async () => {
    const { getRedis } = await import("./index.js");
    const client = getRedis();
    const getSpy = vi.fn().mockResolvedValue("42");
    client.get = getSpy as never;

    expect(await readSupersetUnreconciledCount()).toBe(42);
    expect(getSpy).toHaveBeenCalledWith(SUPERSET_UNRECONCILED_KEY);
  });

  it("returns a null count when the key is missing, unparseable or Redis is down", async () => {
    const { getRedis } = await import("./index.js");
    const client = getRedis();
    client.get = vi.fn().mockResolvedValue(null) as never;
    expect(await readSupersetUnreconciledCount()).toBeNull();

    client.get = vi.fn().mockResolvedValue("not-a-number") as never;
    expect(await readSupersetUnreconciledCount()).toBeNull();

    client.get = vi.fn().mockRejectedValue(new Error("redis down")) as never;
    expect(await readSupersetUnreconciledCount()).toBeNull();
  });

  it("reads the entries back", async () => {
    const { getRedis } = await import("./index.js");
    const client = getRedis();
    const sample = [entry("t1", "h1", 1_000), entry("t2", "h2", 2_000)];
    client.get = vi.fn().mockResolvedValue(JSON.stringify(sample)) as never;

    expect(await readSupersetUnreconciledEntries()).toEqual(sample);
  });

  it("returns null entries when the key is missing, unparseable, not an array or Redis is down", async () => {
    const { getRedis } = await import("./index.js");
    const client = getRedis();
    client.get = vi.fn().mockResolvedValue(null) as never;
    expect(await readSupersetUnreconciledEntries()).toBeNull();

    client.get = vi.fn().mockResolvedValue("not-json") as never;
    expect(await readSupersetUnreconciledEntries()).toBeNull();

    client.get = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ not: "an array" })) as never;
    expect(await readSupersetUnreconciledEntries()).toBeNull();

    client.get = vi.fn().mockRejectedValue(new Error("redis down")) as never;
    expect(await readSupersetUnreconciledEntries()).toBeNull();
  });

  it.each([
    ["missing tenantId", { subjectHash: "h", createdAt: 1 }],
    ["missing subjectHash", { tenantId: "t", createdAt: 1 }],
    [
      "missing createdAt (an older payload)",
      { tenantId: "t", subjectHash: "h" },
    ],
    [
      "a non-numeric createdAt",
      { tenantId: "t", subjectHash: "h", createdAt: "1" },
    ],
    ["a null element", null],
  ])("rejects a payload with an element that has %s", async (_label, bad) => {
    const { getRedis } = await import("./index.js");
    const client = getRedis();
    client.get = vi
      .fn()
      .mockResolvedValue(
        JSON.stringify([entry("t1", "ok", 1_000), bad]),
      ) as never;

    expect(await readSupersetUnreconciledEntries()).toBeNull();
  });
});
