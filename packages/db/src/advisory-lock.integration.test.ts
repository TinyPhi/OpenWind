import { describe, it, expect, vi, afterAll } from "vitest";
import postgres from "postgres";
import { acquireAdvisoryLock } from "./advisory-lock.js";

vi.mock("@platform/logger", () => ({
  logger: { error: vi.fn() },
}));

// Opt-in: set ADVISORY_LOCK_TEST_URL to a DIRECT Postgres URL (port 5432,
// not PgBouncer). Point it at the PgBouncer URL instead to watch #752 happen:
// the exclusion test then fails because a pooled "reserved" connection does not
// pin a backend. CI connects straight to Postgres but cannot be pointed here
// without a workflow change, so this stays a local check.
const url = process.env.ADVISORY_LOCK_TEST_URL;
const SEED = 1;

describe.skipIf(!url)(
  "advisory lock on a real direct connection (#752)",
  () => {
    const clients: postgres.Sql[] = [];
    const connect = (): postgres.Sql => {
      const c = postgres(url as string, { max: 5, prepare: false });
      clients.push(c);
      return c;
    };
    const suffix = `${process.pid}-${Date.now()}`;

    afterAll(async () => {
      await Promise.all(clients.map((c) => c.end({ timeout: 1 })));
    });

    it("excludes a second holder until the first releases", async () => {
      const pool = connect();
      const ns = `it-exclusion-${suffix}`;
      const tenant = "00000000-0000-0000-0000-000000000752";

      const first = await acquireAdvisoryLock(
        () => pool.reserve(),
        tenant,
        ns,
        SEED,
      );
      const second = await acquireAdvisoryLock(
        () => pool.reserve(),
        tenant,
        ns,
        SEED,
      );

      expect(first.acquired).toBe(true);
      expect(second.acquired).toBe(false);

      await first.release();
      const third = await acquireAdvisoryLock(
        () => pool.reserve(),
        tenant,
        ns,
        SEED,
      );
      expect(third.acquired).toBe(true);
      await third.release();
    });

    it("frees the lock when the holder's connection drops without releasing", async () => {
      const holderPool = connect();
      const otherPool = connect();
      const ns = `it-crash-${suffix}`;
      const tenant = "00000000-0000-0000-0000-000000000753";

      const held = await acquireAdvisoryLock(
        () => holderPool.reserve(),
        tenant,
        ns,
        SEED,
      );
      expect(held.acquired).toBe(true);

      await holderPool.end({ timeout: 0 });

      const deadline = Date.now() + 3000;
      let after = await acquireAdvisoryLock(
        () => otherPool.reserve(),
        tenant,
        ns,
        SEED,
      );
      while (!after.acquired && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        after = await acquireAdvisoryLock(
          () => otherPool.reserve(),
          tenant,
          ns,
          SEED,
        );
      }
      expect(after.acquired).toBe(true);
      await after.release();
    });
  },
);
