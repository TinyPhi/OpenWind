import { afterEach, describe, expect, it, vi } from "vitest";

const mockEnv = {
  TELEMETRY_ENABLED: true,
  REDIS_URL: "redis://localhost:6379",
};
vi.mock("@platform/config", () => ({ env: mockEnv }));

const redisReads = {
  count: vi.fn<() => Promise<number | null>>(),
  entries:
    vi.fn<
      () => Promise<
        { tenantId: string; subjectHash: string; createdAt: number }[] | null
      >
    >(),
};
vi.mock("@platform/redis", () => ({
  getRedis: () => ({
    on: vi.fn(),
    quit: vi.fn(),
    keys: vi.fn().mockResolvedValue([]),
    smembers: vi.fn().mockResolvedValue([]),
    scard: vi.fn().mockResolvedValue(0),
    get: vi.fn().mockResolvedValue(null),
  }),
  readSupersetSelfcheck: vi.fn().mockResolvedValue(null),
  readSupersetUnreconciledCount: () => redisReads.count(),
  readSupersetUnreconciledEntries: () => redisReads.entries(),
}));

vi.mock("bullmq", () => ({
  Queue: class MockQueue {
    async getJobCounts() {
      return { active: 0, waiting: 0, delayed: 0, failed: 0 };
    }
  },
  Worker: class MockWorker {},
}));

await import("./instrumentation.js");
const { getSerializedMetrics } = await import("./metrics.js");

const COUNT = "openwind_superset_erasure_unreconciled_older_than_1h";
const AGE = "openwind_superset_erasure_unreconciled_age_seconds";

interface Sample {
  labels: Record<string, string>;
  value: number;
}

/** The samples of one metric from the Prometheus exposition text. */
function samples(text: string, name: string): Sample[] {
  const out: Sample[] = [];
  for (const line of text.split("\n")) {
    const m = new RegExp(`^${name}(?:\\{([^}]*)\\})? (\\S+)`).exec(line);
    if (!m) continue;
    const labels: Record<string, string> = {};
    for (const pair of (m[1] ?? "").matchAll(/(\w+)="([^"]*)"/g)) {
      labels[pair[1] as string] = pair[2] as string;
    }
    out.push({ labels, value: Number(m[2]) });
  }
  return out;
}

/** The labels this feature sets, ignoring the exporter's own scope label. */
function ours(s: Sample): Record<string, string> {
  const { tenant_id, subject_hash } = s.labels;
  return tenant_id === undefined
    ? {}
    : { tenant_id, subject_hash: subject_hash ?? "" };
}

afterEach(() => {
  vi.useRealTimers();
  redisReads.count.mockReset();
  redisReads.entries.mockReset();
});

// The SDK keeps every series it has exported for the life of the process, so each test uses its
// own tenant and subject ids and looks only at its own series.
function ageOf(text: string, tenantId: string, subjectHash: string) {
  return samples(text, AGE).find(
    (s) =>
      ours(s).tenant_id === tenantId && ours(s).subject_hash === subjectHash,
  );
}

describe("Superset erasure gauges (#1138, #1141)", () => {
  it("reports the true count as one unlabelled series, whatever the entry cap kept", async () => {
    redisReads.count.mockResolvedValue(450);
    redisReads.entries.mockResolvedValue([
      { tenantId: "c1", subjectHash: "h1", createdAt: Date.now() - 1000 },
    ]);

    const found = samples(await getSerializedMetrics(), COUNT);
    expect(found).toHaveLength(1);
    expect(found[0]?.value).toBe(450);
    expect(ours(found[0] as Sample)).toEqual({});

    redisReads.count.mockResolvedValue(0);
    redisReads.entries.mockResolvedValue([]);
    const after = samples(await getSerializedMetrics(), COUNT);
    expect(after.map((s) => s.value)).toEqual([0]);
  });

  it("leaves the count where it was when Redis has no value", async () => {
    redisReads.count.mockResolvedValue(7);
    redisReads.entries.mockResolvedValue([]);
    await getSerializedMetrics();

    redisReads.count.mockResolvedValue(null);
    redisReads.entries.mockResolvedValue(null);
    const found = samples(await getSerializedMetrics(), COUNT);
    expect(found.map((s) => s.value)).toEqual([7]);
  });

  it("derives each age from the audit row's createdAt at scrape time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
    const day = 86_400_000;
    redisReads.count.mockResolvedValue(2);
    redisReads.entries.mockResolvedValue([
      { tenantId: "a1", subjectHash: "old", createdAt: Date.now() - 8 * day },
      {
        tenantId: "a2",
        subjectHash: "young",
        createdAt: Date.now() - 2 * 3_600_000,
      },
    ]);

    const text = await getSerializedMetrics();
    expect(ageOf(text, "a1", "old")?.value).toBe(8 * 86_400);
    expect(ageOf(text, "a2", "young")?.value).toBe(7_200);

    // The same stored entries five minutes later: the age grew, nothing was rewritten.
    vi.setSystemTime(new Date("2026-11-24T12:05:00Z"));
    const later = await getSerializedMetrics();
    expect(ageOf(later, "a1", "old")?.value).toBe(8 * 86_400 + 300);
  });

  it("drops a reconciled erasure to 0 and keeps it there (the exporter would otherwise freeze its last age)", async () => {
    const created = Date.now() - 9 * 86_400_000;
    redisReads.count.mockResolvedValue(2);
    redisReads.entries.mockResolvedValue([
      { tenantId: "r1", subjectHash: "done", createdAt: created },
      { tenantId: "r1", subjectHash: "stuck", createdAt: created },
    ]);
    const before = await getSerializedMetrics();
    expect(ageOf(before, "r1", "done")?.value).toBeGreaterThan(8 * 86_400);

    redisReads.count.mockResolvedValue(1);
    redisReads.entries.mockResolvedValue([
      { tenantId: "r1", subjectHash: "stuck", createdAt: created },
    ]);
    const after = await getSerializedMetrics();
    expect(ageOf(after, "r1", "done")?.value).toBe(0);
    expect(ageOf(after, "r1", "stuck")?.value).toBeGreaterThan(8 * 86_400);

    const again = await getSerializedMetrics();
    expect(ageOf(again, "r1", "done")?.value).toBe(0);
  });

  it("drops every series to 0 when the list becomes empty", async () => {
    redisReads.count.mockResolvedValue(1);
    redisReads.entries.mockResolvedValue([
      { tenantId: "e1", subjectHash: "h", createdAt: Date.now() - 86_400_000 },
    ]);
    await getSerializedMetrics();

    redisReads.count.mockResolvedValue(0);
    redisReads.entries.mockResolvedValue([]);
    const text = await getSerializedMetrics();
    expect(ageOf(text, "e1", "h")?.value).toBe(0);
  });

  it("keeps the last ages when Redis has no snapshot, rather than resetting them", async () => {
    const created = Date.now() - 10 * 86_400_000;
    redisReads.count.mockResolvedValue(1);
    redisReads.entries.mockResolvedValue([
      { tenantId: "k1", subjectHash: "h", createdAt: created },
    ]);
    const before = await getSerializedMetrics();
    const seen = ageOf(before, "k1", "h")?.value as number;
    expect(seen).toBeGreaterThan(9 * 86_400);

    redisReads.count.mockResolvedValue(null);
    redisReads.entries.mockResolvedValue(null);
    const during = await getSerializedMetrics();
    expect(ageOf(during, "k1", "h")?.value).toBeGreaterThanOrEqual(seen);

    redisReads.entries.mockRejectedValue(new Error("redis down"));
    const down = await getSerializedMetrics();
    expect(ageOf(down, "k1", "h")?.value).toBeGreaterThanOrEqual(seen);
  });

  it("never reports a negative age for a createdAt slightly ahead of this clock", async () => {
    redisReads.count.mockResolvedValue(1);
    redisReads.entries.mockResolvedValue([
      { tenantId: "n1", subjectHash: "h", createdAt: Date.now() + 60_000 },
    ]);

    const text = await getSerializedMetrics();
    expect(ageOf(text, "n1", "h")?.value).toBe(0);
  });
});
