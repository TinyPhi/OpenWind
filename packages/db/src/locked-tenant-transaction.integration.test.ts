import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  runLockedTenantTransaction,
  SavepointNotAllowedError,
  LockedTransactionClosedError,
} from "./locked-tenant-transaction.js";

// Runs against a real Postgres. LOCKED_TX_TEST_URL wins so the same file can be
// pointed at PgBouncer (transaction pooling) to prove the lock holds there;
// otherwise it uses DATABASE_URL, which CI and docs/local-setup.md both set.
// The scratch table needs DDL rights, which the app_user URL PgBouncer fronts
// lacks, so setup and verification use LOCKED_TX_ADMIN_URL (a direct,
// privileged URL to the same database) when set.
const url = process.env.LOCKED_TX_TEST_URL ?? process.env.DATABASE_URL;
const adminUrl = process.env.LOCKED_TX_ADMIN_URL ?? url;

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

describe.skipIf(!url)("withLockedTenantTransaction on a real Postgres", () => {
  const clients: postgres.Sql[] = [];
  const connect = (): postgres.Sql => {
    const c = postgres(url as string, { max: 5, prepare: false });
    clients.push(c);
    return c;
  };
  const probe = `locked_tx_probe_${process.pid}_${Date.now()}`;
  const lockKey = (name: string): string => `${probe}:${name}`;
  let admin: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(adminUrl as string, { max: 2, prepare: false });
    clients.push(admin);
    await admin.unsafe(`
      CREATE TABLE ${probe} (id serial PRIMARY KEY, tenant_id uuid NOT NULL, note text);
      ALTER TABLE ${probe} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY probe_tenant ON ${probe}
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
      GRANT SELECT, INSERT ON ${probe} TO app_user;
      GRANT USAGE ON SEQUENCE ${probe}_id_seq TO app_user;
    `);
  });

  afterAll(async () => {
    await admin.unsafe(`DROP TABLE IF EXISTS ${probe}`);
    await Promise.all(clients.map((c) => c.end({ timeout: 1 })));
  });

  const rowCount = async (note?: string): Promise<number> => {
    const rows = await admin.unsafe(
      `SELECT count(*)::int AS n FROM ${probe}${note ? ` WHERE note = '${note}'` : ""}`,
    );
    return (rows[0] as { n: number }).n;
  };

  it("runs as app_user with the tenant GUC set", async () => {
    const pool = connect();

    const result = await runLockedTenantTransaction(
      pool,
      { tenantId: TENANT_A, lockKey: lockKey("role"), lockSeed: 2 },
      async ({ db }) => {
        const ctx = await db.execute(
          sql`SELECT current_user AS role, current_setting('app.tenant_id') AS tenant`,
        );
        return ctx[0];
      },
    );

    expect(result).toMatchObject({
      acquired: true,
      value: { role: "app_user", tenant: TENANT_A },
    });
  });

  it("enforces RLS: a row for another tenant is refused and nothing from the transaction commits", async () => {
    const pool = connect();
    const note = "rls";

    await expect(
      runLockedTenantTransaction(
        pool,
        { tenantId: TENANT_A, lockKey: lockKey("rls"), lockSeed: 2 },
        async ({ exec }) => {
          await exec(
            `INSERT INTO ${probe} (tenant_id, note) VALUES ('${TENANT_A}', '${note}')`,
          );
          await exec(
            `INSERT INTO ${probe} (tenant_id, note) VALUES ('${TENANT_B}', '${note}')`,
          );
        },
      ),
    ).rejects.toMatchObject({ code: "42501" });

    expect(await rowCount(note)).toBe(0);
  });

  it("still rolls back when fn catches a failed statement, so a swallowed error cannot commit a half-applied change", async () => {
    const pool = connect();
    const note = "swallowed";

    await expect(
      runLockedTenantTransaction(
        pool,
        { tenantId: TENANT_A, lockKey: lockKey("swallow"), lockSeed: 2 },
        async ({ exec }) => {
          await exec(
            `INSERT INTO ${probe} (tenant_id, note) VALUES ('${TENANT_A}', '${note}')`,
          );
          await exec(`INSERT INTO ${probe} (no_such_column) VALUES (1)`).catch(
            () => undefined,
          );
          return "carried on";
        },
      ),
    ).rejects.toMatchObject({ code: "42703" });

    expect(await rowCount(note)).toBe(0);
  });

  it("excludes a concurrent caller on the same key until the first finishes", async () => {
    const pool = connect();
    const options = {
      tenantId: TENANT_A,
      lockKey: lockKey("excl"),
      lockSeed: 2,
    };

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => (entered = resolve));

    const first = runLockedTenantTransaction(pool, options, async () => {
      entered();
      await gate;
      return "first";
    });
    await holding;

    const second = await runLockedTenantTransaction(
      pool,
      options,
      async () => "second",
    );
    const otherKey = await runLockedTenantTransaction(
      pool,
      { ...options, lockKey: lockKey("excl-other") },
      async () => "other",
    );
    release();
    const firstResult = await first;
    const third = await runLockedTenantTransaction(
      pool,
      options,
      async () => "third",
    );

    expect(second).toEqual({ acquired: false });
    expect(otherKey).toMatchObject({ acquired: true, value: "other" });
    expect(firstResult).toMatchObject({ acquired: true, value: "first" });
    expect(third).toMatchObject({ acquired: true, value: "third" });
  });

  it("sees uncommitted writes from exec and Drizzle together, and commits them atomically", async () => {
    const pool = connect();
    const note = "commit";

    const result = await runLockedTenantTransaction(
      pool,
      { tenantId: TENANT_A, lockKey: lockKey("commit"), lockSeed: 2 },
      async ({ db, exec }) => {
        await exec(
          `INSERT INTO ${probe} (tenant_id, note) VALUES ('${TENANT_A}', '${note}');` +
            `INSERT INTO ${probe} (tenant_id, note) VALUES ('${TENANT_A}', '${note}');`,
        );
        await db.execute(
          sql.raw(
            `INSERT INTO ${probe} (tenant_id, note) VALUES ('${TENANT_A}', '${note}')`,
          ),
        );
        const inside = await db.execute(
          sql.raw(
            `SELECT count(*)::int AS n FROM ${probe} WHERE note = '${note}'`,
          ),
        );
        return {
          inside: (inside[0] as { n: number }).n,
          outside: await rowCount(note),
        };
      },
    );

    expect(result).toMatchObject({
      acquired: true,
      value: { inside: 3, outside: 0 },
    });
    expect(await rowCount(note)).toBe(3);
  });

  it("stamps every row, from exec and from Drizzle, with the one transaction's xid (no savepoint)", async () => {
    const pool = connect();
    const note = "xmin";

    const result = await runLockedTenantTransaction(
      pool,
      { tenantId: TENANT_A, lockKey: lockKey("xmin"), lockSeed: 2 },
      async ({ db, exec }) => {
        await exec(
          `INSERT INTO ${probe} (tenant_id, note) VALUES ('${TENANT_A}', '${note}')`,
        );
        await db.execute(
          sql.raw(
            `INSERT INTO ${probe} (tenant_id, note) VALUES ('${TENANT_A}', '${note}')`,
          ),
        );
        const counted = await db.execute(
          sql.raw(
            `SELECT count(*)::int AS n FROM ${probe} WHERE note = '${note}' AND xmin = pg_current_xact_id()::xid`,
          ),
        );
        return (counted[0] as { n: number }).n;
      },
    );

    expect(result).toMatchObject({ acquired: true, value: 2 });
  });

  it("rolls back every earlier statement and rethrows the original error when a later one fails", async () => {
    const pool = connect();
    const note = "fail";

    await expect(
      runLockedTenantTransaction(
        pool,
        { tenantId: TENANT_A, lockKey: lockKey("fail"), lockSeed: 2 },
        async ({ exec }) => {
          await exec(
            `INSERT INTO ${probe} (tenant_id, note) VALUES ('${TENANT_A}', '${note}')`,
          );
          await exec(`INSERT INTO ${probe} (no_such_column) VALUES (1)`);
        },
      ),
    ).rejects.toMatchObject({ code: "42703" });

    expect(await rowCount(note)).toBe(0);

    const after = await runLockedTenantTransaction(
      pool,
      { tenantId: TENANT_A, lockKey: lockKey("fail"), lockSeed: 2 },
      async () => "free",
    );
    expect(after).toMatchObject({ acquired: true, value: "free" });
  });

  it("changes nothing on a dry run, returns the value, and frees the lock", async () => {
    const pool = connect();
    const note = "dry";
    const options = {
      tenantId: TENANT_A,
      lockKey: lockKey("dry"),
      lockSeed: 2,
    };

    const result = await runLockedTenantTransaction(
      pool,
      { ...options, dryRun: true },
      async ({ exec, db }) => {
        await exec(
          `INSERT INTO ${probe} (tenant_id, note) VALUES ('${TENANT_A}', '${note}')`,
        );
        const counted = await db.execute(
          sql.raw(
            `SELECT count(*)::int AS n FROM ${probe} WHERE note = '${note}'`,
          ),
        );
        return (counted[0] as { n: number }).n;
      },
    );

    expect(result).toEqual({ acquired: true, value: 1, rolledBack: true });
    expect(await rowCount(note)).toBe(0);
    expect(
      await runLockedTenantTransaction(pool, options, async () => "free"),
    ).toMatchObject({ acquired: true });
  });

  it("refuses db.transaction, so a nested call cannot open a SAVEPOINT", async () => {
    const pool = connect();

    const result = await runLockedTenantTransaction(
      pool,
      { tenantId: TENANT_A, lockKey: lockKey("savepoint"), lockSeed: 2 },
      async ({ db }) =>
        db
          .transaction(async () => undefined)
          .then(
            () => "opened",
            (e: unknown) => e,
          ),
    );

    expect(result).toMatchObject({ acquired: true });
    expect((result as { value: unknown }).value).toBeInstanceOf(
      SavepointNotAllowedError,
    );
  });

  it("refuses db.$client.savepoint, so a SAVEPOINT cannot be opened through the raw handle", async () => {
    const pool = connect();

    const result = await runLockedTenantTransaction(
      pool,
      { tenantId: TENANT_A, lockKey: lockKey("savepoint-raw"), lockSeed: 2 },
      async ({ db }) => {
        const raw = db.$client as unknown as { savepoint: () => unknown };
        try {
          raw.savepoint();
          return "opened";
        } catch (e) {
          return e;
        }
      },
    );

    expect((result as { value: unknown }).value).toBeInstanceOf(
      SavepointNotAllowedError,
    );
  });

  it("refuses a db or exec kept past the callback instead of running it on the pool as the pool's own role", async () => {
    const pool = connect();
    const note = "stale";

    const result = await runLockedTenantTransaction(
      pool,
      { tenantId: TENANT_A, lockKey: lockKey("stale"), lockSeed: 2 },
      async (ctx) => ctx,
    );
    if (!result.acquired) throw new Error("expected the lock to be acquired");
    const { db, exec } = result.value;

    await expect(
      exec(
        `INSERT INTO ${probe} (tenant_id, note) VALUES ('${TENANT_A}', '${note}')`,
      ),
    ).rejects.toBeInstanceOf(LockedTransactionClosedError);
    // drizzle wraps whatever the driver throws in a DrizzleQueryError and keeps
    // the original as `cause`.
    await expect(
      db.execute(sql`SELECT current_user AS role`),
    ).rejects.toMatchObject({
      cause: expect.any(LockedTransactionClosedError) as unknown,
    });
    expect(await rowCount(note)).toBe(0);
  });
});
