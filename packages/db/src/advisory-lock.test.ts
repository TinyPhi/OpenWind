import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type postgres from "postgres";
import {
  acquireAdvisoryLock,
  reserveWithTimeout,
  AdvisoryLockPoolExhaustedError,
} from "./advisory-lock.js";

const mockLoggerError = vi.fn();
vi.mock("@platform/logger", () => ({
  logger: { error: (...a: unknown[]) => mockLoggerError(...a) },
}));

type ReservedSql = postgres.ReservedSql;

const SEED = 1;
const TENANT_A = "00000000-0000-0000-0000-00000000000a";
const TENANT_B = "00000000-0000-0000-0000-00000000000b";

// A fake Postgres: `held` is the database-wide advisory lock table, each fake
// connection is one backend with its own pid. Session locks are re-entrant per
// backend, like the real thing -- that is what made #752 a double-grant.
function makeServer() {
  const held = new Map<string, number>();
  let nextPid = 100;
  const connections: Array<{ pid: number; release: ReturnType<typeof vi.fn> }> =
    [];

  function connect(overrides?: {
    pidOnUnlock?: number;
    unlockResult?: boolean;
    failLockQuery?: boolean;
    failUnlockQuery?: boolean;
  }): ReservedSql {
    const pid = nextPid++;
    const release = vi.fn();
    connections.push({ pid, release });
    const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      const key = String(values[0]);
      if (text.includes("pg_try_advisory_lock")) {
        if (overrides?.failLockQuery) throw new Error("connection blip");
        const owner = held.get(key);
        if (owner === undefined || owner === pid) {
          held.set(key, pid);
          return [{ locked: true, pid }];
        }
        return [{ locked: false, pid }];
      }
      if (text.includes("pg_advisory_unlock")) {
        if (overrides?.failUnlockQuery) throw new Error("connection reset");
        const unlocked = overrides?.unlockResult ?? held.get(key) === pid;
        if (unlocked) held.delete(key);
        return [{ unlocked, pid: overrides?.pidOnUnlock ?? pid }];
      }
      throw new Error(`unexpected query: ${text}`);
    };
    // The fake only needs the tagged-template call and release(); the rest of
    // postgres-js's ReservedSql surface is irrelevant to the lock logic.
    return Object.assign(sql, { release }) as unknown as ReservedSql;
  }

  return { held, connections, connect };
}

beforeEach(() => {
  mockLoggerError.mockReset();
});

describe("acquireAdvisoryLock -- mutual exclusion", () => {
  it("refuses a second holder of the same key until the first releases", async () => {
    const server = makeServer();
    const reserve = () => Promise.resolve(server.connect());

    const first = await acquireAdvisoryLock(reserve, TENANT_A, "ns", SEED);
    const second = await acquireAdvisoryLock(reserve, TENANT_A, "ns", SEED);

    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);

    await first.release();
    const third = await acquireAdvisoryLock(reserve, TENANT_A, "ns", SEED);
    expect(third.acquired).toBe(true);
    await third.release();
  });

  it("does not block a different tenant or a different namespace", async () => {
    const server = makeServer();
    const reserve = () => Promise.resolve(server.connect());

    const a = await acquireAdvisoryLock(reserve, TENANT_A, "ns", SEED);
    const otherTenant = await acquireAdvisoryLock(
      reserve,
      TENANT_B,
      "ns",
      SEED,
    );
    const otherNamespace = await acquireAdvisoryLock(
      reserve,
      TENANT_A,
      "other",
      SEED,
    );

    expect(a.acquired).toBe(true);
    expect(otherTenant.acquired).toBe(true);
    expect(otherNamespace.acquired).toBe(true);
  });

  it("hands the connection straight back when the lock is already held", async () => {
    const server = makeServer();
    const reserve = () => Promise.resolve(server.connect());
    await acquireAdvisoryLock(reserve, TENANT_A, "ns", SEED);

    const refused = await acquireAdvisoryLock(reserve, TENANT_A, "ns", SEED);

    expect(refused.acquired).toBe(false);
    expect(server.connections[1]?.release).toHaveBeenCalledOnce();
    await expect(refused.release()).resolves.toBeUndefined();
  });

  it("releases the connection and rethrows when the lock query fails", async () => {
    const server = makeServer();
    const conn = server.connect({ failLockQuery: true });

    await expect(
      acquireAdvisoryLock(() => Promise.resolve(conn), TENANT_A, "ns", SEED),
    ).rejects.toThrow("connection blip");

    expect(server.connections[0]?.release).toHaveBeenCalledOnce();
  });
});

describe("acquireAdvisoryLock -- release", () => {
  it("releases the connection once and treats a second release as a no-op", async () => {
    const server = makeServer();
    const lock = await acquireAdvisoryLock(
      () => Promise.resolve(server.connect()),
      TENANT_A,
      "ns",
      SEED,
    );

    await lock.release();
    await lock.release();

    expect(server.connections[0]?.release).toHaveBeenCalledOnce();
    expect(server.held.size).toBe(0);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("logs an anomaly when the unlock ran on a different backend, without throwing", async () => {
    const server = makeServer();
    const conn = server.connect({ pidOnUnlock: 999, unlockResult: false });
    const lock = await acquireAdvisoryLock(
      () => Promise.resolve(conn),
      TENANT_A,
      "ns",
      SEED,
    );

    await expect(lock.release()).resolves.toBeUndefined();

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_A,
        namespace: "ns",
        acquirePid: 100,
        releasePid: 999,
        unlocked: false,
      }),
      expect.stringContaining("different backend"),
    );
    expect(server.connections[0]?.release).toHaveBeenCalledOnce();
  });

  it("logs a failed release, rethrows, and still returns the connection when the unlock query throws", async () => {
    const server = makeServer();
    const conn = server.connect({ failUnlockQuery: true });
    const lock = await acquireAdvisoryLock(
      () => Promise.resolve(conn),
      TENANT_A,
      "ns",
      SEED,
    );

    await expect(lock.release()).rejects.toThrow("connection reset");

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_A,
        namespace: "ns",
        error: "Error: connection reset",
      }),
      expect.stringContaining("release failed"),
    );
    expect(server.connections[0]?.release).toHaveBeenCalledOnce();
  });

  it("logs an anomaly when the unlock returns false on the same backend", async () => {
    const server = makeServer();
    const conn = server.connect({ unlockResult: false });
    const lock = await acquireAdvisoryLock(
      () => Promise.resolve(conn),
      TENANT_A,
      "ns",
      SEED,
    );

    await lock.release();

    expect(mockLoggerError).toHaveBeenCalledOnce();
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("returned false"),
    );
  });

  it("logs a backend switch even when the unlock itself succeeds", async () => {
    const server = makeServer();
    const conn = server.connect({ pidOnUnlock: 555 });
    const lock = await acquireAdvisoryLock(
      () => Promise.resolve(conn),
      TENANT_A,
      "ns",
      SEED,
    );

    await lock.release();

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ acquirePid: 100, releasePid: 555 }),
      expect.any(String),
    );
  });
});

describe("reserveWithTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the connection when a slot is free", async () => {
    const server = makeServer();
    const conn = server.connect();

    await expect(
      reserveWithTimeout({ reserve: () => Promise.resolve(conn) }, 50),
    ).resolves.toBe(conn);
  });

  it("rejects with the typed pool-exhausted error when no slot frees in time", async () => {
    vi.useFakeTimers();
    const never = new Promise<ReservedSql>(() => {});

    const result = reserveWithTimeout({ reserve: () => never }, 5000);
    const assertion = expect(result).rejects.toBeInstanceOf(
      AdvisoryLockPoolExhaustedError,
    );
    await vi.advanceTimersByTimeAsync(5000);

    await assertion;
  });

  it("releases a connection that arrives after the timeout", async () => {
    vi.useFakeTimers();
    const server = makeServer();
    const late = server.connect();
    let resolveLate!: (c: ReservedSql) => void;
    const pending = new Promise<ReservedSql>((resolve) => {
      resolveLate = resolve;
    });

    const result = reserveWithTimeout({ reserve: () => pending }, 100);
    const assertion = expect(result).rejects.toBeInstanceOf(
      AdvisoryLockPoolExhaustedError,
    );
    await vi.advanceTimersByTimeAsync(100);
    await assertion;

    resolveLate(late);
    await vi.advanceTimersByTimeAsync(0);

    expect(server.connections[0]?.release).toHaveBeenCalledOnce();
  });

  it("propagates a reserve failure and leaves no timer behind", async () => {
    vi.useFakeTimers();

    await expect(
      reserveWithTimeout(
        { reserve: () => Promise.reject(new Error("pool closed")) },
        5000,
      ),
    ).rejects.toThrow("pool closed");

    expect(vi.getTimerCount()).toBe(0);
  });
});
