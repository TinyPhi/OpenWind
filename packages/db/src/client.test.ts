import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLoggerError = vi.fn();
const mockLoggerInfo = vi.fn();
vi.mock("@platform/logger", () => ({
  logger: {
    error: (...a: unknown[]) => mockLoggerError(...a),
    warn: vi.fn(),
    info: (...a: unknown[]) => mockLoggerInfo(...a),
  },
}));

const MAIN_URL = "postgres://app_user:pw@pgbouncer:5432/platform";
const DIRECT_URL = "postgres://app_user:pw@postgres:5432/platform";

const mockEnv: {
  DATABASE_URL: string;
  DATABASE_POOL_MAX: number;
  DATABASE_DIRECT_URL?: string;
  DATABASE_LOCK_POOL_MAX: number;
} = {
  DATABASE_URL: MAIN_URL,
  DATABASE_POOL_MAX: 10,
  DATABASE_LOCK_POOL_MAX: 5,
};
vi.mock("@platform/config", () => ({ env: mockEnv }));
// The wiring under test never touches the table definitions; stubbing them keeps
// each re-import of client.js cheap, so the suite is not at the mercy of load.
vi.mock("./schema/index.js", () => ({}));

// postgres() stand-in: every client is a tagged-template function plus
// reserve(), tagged with the URL it was built for so a test can see which
// client a lock connection came from.
type FakeClient = ((s: TemplateStringsArray, ...v: unknown[]) => unknown) & {
  url: string;
  opts: Record<string, unknown>;
  reserve: ReturnType<typeof vi.fn>;
};
const created: FakeClient[] = [];
vi.mock("postgres", () => ({
  default: (url: string, opts: Record<string, unknown>) => {
    const reserved = Object.assign(
      async (strings: TemplateStringsArray) =>
        strings.join("?").includes("pg_try_advisory_lock")
          ? [{ locked: true, pid: 1 }]
          : [{ unlocked: true, pid: 1 }],
      { release: vi.fn() },
    );
    const client = Object.assign(() => undefined, {
      url,
      opts,
      // drizzle reads these when it wraps the client
      options: { parsers: {}, serializers: {} },
      reserve: vi.fn().mockResolvedValue(reserved),
    }) as unknown as FakeClient;
    created.push(client);
    return client;
  },
}));

beforeEach(() => {
  created.length = 0;
  mockLoggerError.mockReset();
  mockLoggerInfo.mockReset();
  vi.resetModules();
});

const TENANT = "00000000-0000-0000-0000-000000000752";

describe("acquireTenantAdvisoryLock wiring (#752)", { timeout: 30_000 }, () => {
  it("uses the main client and opens no extra pool when DATABASE_DIRECT_URL is unset", async () => {
    delete mockEnv.DATABASE_DIRECT_URL;
    const { acquireTenantAdvisoryLock } = await import("./client.js");

    const lock = await acquireTenantAdvisoryLock(TENANT, "ns");
    await lock.release();

    expect(created).toHaveLength(1);
    expect(created[0]?.url).toBe(MAIN_URL);
    expect(created[0]?.reserve).toHaveBeenCalledOnce();
  });

  it("takes the lock connection from a dedicated direct pool when DATABASE_DIRECT_URL is set", async () => {
    mockEnv.DATABASE_DIRECT_URL = DIRECT_URL;
    mockEnv.DATABASE_LOCK_POOL_MAX = 3;
    const { acquireTenantAdvisoryLock } = await import("./client.js");

    const lock = await acquireTenantAdvisoryLock(TENANT, "ns");
    await lock.release();

    const main = created.find((c) => c.url === MAIN_URL);
    const direct = created.find((c) => c.url === DIRECT_URL);
    expect(direct?.opts).toMatchObject({ max: 3, prepare: false });
    expect(direct?.reserve).toHaveBeenCalledOnce();
    expect(main?.reserve).not.toHaveBeenCalled();
  });

  it("creates the direct pool once and reuses it across acquisitions", async () => {
    mockEnv.DATABASE_DIRECT_URL = DIRECT_URL;
    const { acquireTenantAdvisoryLock } = await import("./client.js");

    await (await acquireTenantAdvisoryLock(TENANT, "ns")).release();
    await (await acquireTenantAdvisoryLock(TENANT, "ns")).release();

    expect(created.filter((c) => c.url === DIRECT_URL)).toHaveLength(1);
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      { max: mockEnv.DATABASE_LOCK_POOL_MAX },
      "advisory lock pool created",
    );
  });

  it("opens no direct pool in a process that never takes a lock", async () => {
    mockEnv.DATABASE_DIRECT_URL = DIRECT_URL;
    await import("./client.js");

    expect(created.filter((c) => c.url === DIRECT_URL)).toHaveLength(0);
  });
});
