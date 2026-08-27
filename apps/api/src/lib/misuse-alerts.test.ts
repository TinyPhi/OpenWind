import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory fake Redis implementing just the commands misuse-alerts.ts uses
// (incr/expire/mget/set NX) -- faithful enough to exercise the real
// threshold/dedup logic rather than mocking every call individually.
class FakeRedis {
  private store = new Map<string, string>();

  async incr(key: string): Promise<number> {
    const next = (Number(this.store.get(key)) || 0) + 1;
    this.store.set(key, String(next));
    return next;
  }

  async expire(_key: string, _seconds: number): Promise<number> {
    return 1;
  }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    return keys.map((k) => this.store.get(k) ?? null);
  }

  async set(
    key: string,
    value: string,
    _ex: "EX",
    _seconds: number,
    nx: "NX",
  ): Promise<"OK" | null> {
    if (nx === "NX" && this.store.has(key)) return null;
    this.store.set(key, value);
    return "OK";
  }

  async eval(
    _script: string,
    _numKeys: number,
    key: string,
    _seconds: string,
  ): Promise<number> {
    if (!this.store.has(key)) {
      this.store.set(key, "0");
    }
    const next = (Number(this.store.get(key)) || 0) + 1;
    this.store.set(key, String(next));
    return next;
  }

  seed(key: string, value: number): void {
    this.store.set(key, String(value));
  }
}

let fakeRedis: FakeRedis;
vi.mock("@platform/redis", () => ({
  getRedis: () => fakeRedis,
  withRedisTimeout: async <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock("@platform/db", () => ({
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn({}),
}));

const fireMisuseAlertCalls: Array<{ reason: string; context: unknown }> = [];
vi.mock("@platform/notifications", () => ({
  fireMisuseAlert: (
    _tx: unknown,
    _tenantId: string,
    reason: string,
    context: unknown,
  ) => {
    fireMisuseAlertCalls.push({ reason, context });
    return Promise.resolve();
  },
}));

vi.mock("@platform/logger", () => ({
  logger: { warn: vi.fn() },
}));

const { recordScopeDenialAndMaybeAlert, recordRequestVolumeAndMaybeAlert } =
  await import("./misuse-alerts.js");

const TENANT = "tenant-a";
const KEY = "app-key-1";

describe("recordScopeDenialAndMaybeAlert (spec R4 trigger 1)", () => {
  beforeEach(() => {
    fakeRedis = new FakeRedis();
    fireMisuseAlertCalls.length = 0;
  });

  it("fires exactly one alert on the request where the count reaches the threshold (10)", async () => {
    for (let i = 0; i < 9; i++) {
      await recordScopeDenialAndMaybeAlert(TENANT, KEY);
    }
    expect(fireMisuseAlertCalls).toHaveLength(0);

    await recordScopeDenialAndMaybeAlert(TENANT, KEY);
    expect(fireMisuseAlertCalls).toHaveLength(1);
    expect(fireMisuseAlertCalls[0]?.context).toEqual(
      expect.objectContaining({
        trigger: "auth_failure_rate",
        applicationActorId: KEY,
      }),
    );
  });

  it("does not fire again for further denials past the threshold within the same window", async () => {
    for (let i = 0; i < 15; i++) {
      await recordScopeDenialAndMaybeAlert(TENANT, KEY);
    }
    expect(fireMisuseAlertCalls).toHaveLength(1);
  });

  it("does not fire under normal, below-threshold usage", async () => {
    for (let i = 0; i < 5; i++) {
      await recordScopeDenialAndMaybeAlert(TENANT, KEY);
    }
    expect(fireMisuseAlertCalls).toHaveLength(0);
  });
});

describe("recordRequestVolumeAndMaybeAlert (spec R4 trigger 2)", () => {
  beforeEach(() => {
    fakeRedis = new FakeRedis();
    fireMisuseAlertCalls.length = 0;
  });

  it("does not fire with fewer than 24 hours of baseline history, even at a huge current count", async () => {
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    for (let i = 1; i <= 10; i++) {
      fakeRedis.seed(`misuse:volume:${TENANT}:${KEY}:${hourBucket - i}`, 10);
    }
    for (let i = 0; i < 500; i++) {
      await recordRequestVolumeAndMaybeAlert(TENANT, KEY);
    }
    expect(fireMisuseAlertCalls).toHaveLength(0);
  });

  it("fires once when current-hour volume exceeds 5x the trailing baseline, with 24+ hours of history", async () => {
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    for (let i = 1; i <= 24; i++) {
      fakeRedis.seed(`misuse:volume:${TENANT}:${KEY}:${hourBucket - i}`, 10);
    }
    // baseline = 10, threshold = 50 -> 51 requests this hour should cross it
    for (let i = 0; i < 51; i++) {
      await recordRequestVolumeAndMaybeAlert(TENANT, KEY);
    }
    expect(fireMisuseAlertCalls).toHaveLength(1);
    expect(fireMisuseAlertCalls[0]?.context).toEqual(
      expect.objectContaining({
        trigger: "volume_spike",
        applicationActorId: KEY,
      }),
    );

    // Further requests in the SAME hour must not re-fire (dedup).
    for (let i = 0; i < 20; i++) {
      await recordRequestVolumeAndMaybeAlert(TENANT, KEY);
    }
    expect(fireMisuseAlertCalls).toHaveLength(1);
  });

  it("does not fire under normal usage at or below the baseline multiple", async () => {
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    for (let i = 1; i <= 24; i++) {
      fakeRedis.seed(`misuse:volume:${TENANT}:${KEY}:${hourBucket - i}`, 10);
    }
    // baseline = 10, threshold = 50 -> 40 requests stays under it
    for (let i = 0; i < 40; i++) {
      await recordRequestVolumeAndMaybeAlert(TENANT, KEY);
    }
    expect(fireMisuseAlertCalls).toHaveLength(0);
  });
});
