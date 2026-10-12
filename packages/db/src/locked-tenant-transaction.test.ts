import { describe, it, expect, vi } from "vitest";
import type postgres from "postgres";
import {
  runLockedTenantTransaction,
  SavepointNotAllowedError,
  LockedTransactionClosedError,
} from "./locked-tenant-transaction.js";

type Statement = { text: string; values: unknown[] };

/**
 * A stand-in for a postgres-js client: `begin(cb)` runs `cb` with a transaction
 * handle that records every statement, and rejects with whatever `cb` throws,
 * like the real one (which issues ROLLBACK). `lockResult` is what the advisory
 * lock query returns.
 */
function makeClient(lockResult: boolean) {
  const statements: Statement[] = [];
  const unsafeCalls: string[] = [];
  const tx = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?").replace(/\s+/g, " ").trim();
      statements.push({ text, values });
      return Promise.resolve(
        text.includes("pg_try_advisory_xact_lock")
          ? [{ locked: lockResult }]
          : [],
      );
    },
    {
      unsafe: (sql: string) => {
        unsafeCalls.push(sql);
        return Promise.resolve([]);
      },
    },
  );
  const begin = vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
  // Like the real one, the transaction handle has no `options`; only the parent
  // client does, and drizzle() writes its parsers onto it.
  const client = {
    begin,
    options: { parsers: {}, serializers: {} },
  } as unknown as postgres.Sql;
  return { client, statements, unsafeCalls, begin };
}

const OPTIONS = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  lockKey: "module-upgrade:t:helpdesk",
  lockSeed: 2,
};

describe("runLockedTenantTransaction", () => {
  it("takes the lock first, then switches role and sets the tenant GUC, then runs fn", async () => {
    const { client, statements } = makeClient(true);
    const fn = vi.fn().mockResolvedValue("done");

    const result = await runLockedTenantTransaction(client, OPTIONS, fn);

    expect(result).toEqual({
      acquired: true,
      value: "done",
      rolledBack: false,
    });
    expect(statements.map((s) => s.text)).toEqual([
      "SELECT pg_try_advisory_xact_lock( hashtextextended(?, ?) ) AS locked",
      "SET LOCAL ROLE app_user",
      "SELECT set_config('app.tenant_id', ?, true)",
    ]);
    expect(statements[0]?.values).toEqual([OPTIONS.lockKey, OPTIONS.lockSeed]);
    expect(statements[2]?.values).toEqual([OPTIONS.tenantId]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns acquired:false without switching role or running fn when the lock is busy", async () => {
    const { client, statements } = makeClient(false);
    const fn = vi.fn();

    const result = await runLockedTenantTransaction(client, OPTIONS, fn);

    expect(result).toEqual({ acquired: false });
    expect(fn).not.toHaveBeenCalled();
    expect(statements).toHaveLength(1);
  });

  it("runs raw SQL through unsafe() on the same transaction", async () => {
    const { client, unsafeCalls } = makeClient(true);

    await runLockedTenantTransaction(client, OPTIONS, async ({ exec }) => {
      await exec("INSERT INTO a VALUES (1); INSERT INTO b VALUES (2);");
      await exec("SELECT 1");
    });

    expect(unsafeCalls).toEqual([
      "INSERT INTO a VALUES (1); INSERT INTO b VALUES (2);",
      "SELECT 1",
    ]);
  });

  it("rethrows the original error from fn", async () => {
    const { client } = makeClient(true);
    const boom = new Error("statement failed");

    await expect(
      runLockedTenantTransaction(client, OPTIONS, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it("forces a rollback on dry run and still returns fn's value", async () => {
    const { client, begin } = makeClient(true);

    const result = await runLockedTenantTransaction(
      client,
      { ...OPTIONS, dryRun: true },
      async () => ({ added: { fields: 2 } }),
    );

    expect(result).toEqual({
      acquired: true,
      value: { added: { fields: 2 } },
      rolledBack: true,
    });
    // The rollback is the transaction callback throwing, so begin() rejected.
    await expect(begin.mock.results[0]?.value).rejects.toBeDefined();
  });

  it("does not run fn on a dry run when the lock is busy", async () => {
    const { client } = makeClient(false);
    const fn = vi.fn();

    const result = await runLockedTenantTransaction(
      client,
      { ...OPTIONS, dryRun: true },
      fn,
    );

    expect(result).toEqual({ acquired: false });
    expect(fn).not.toHaveBeenCalled();
  });

  it("disables db.transaction so nothing can open a SAVEPOINT", async () => {
    const { client } = makeClient(true);

    await runLockedTenantTransaction(client, OPTIONS, async ({ db }) => {
      await expect(
        db.transaction(async () => undefined),
      ).rejects.toBeInstanceOf(SavepointNotAllowedError);
    });
  });

  it("blocks db.$client.savepoint as well as db.transaction", async () => {
    const { client } = makeClient(true);

    await runLockedTenantTransaction(client, OPTIONS, async ({ db }) => {
      const raw = db.$client as unknown as { savepoint: () => unknown };
      expect(() => raw.savepoint()).toThrow(SavepointNotAllowedError);
    });
  });

  it("rejects exec and db use after the callback has finished", async () => {
    const { client, unsafeCalls } = makeClient(true);

    const result = await runLockedTenantTransaction(
      client,
      OPTIONS,
      async (ctx) => ctx,
    );
    if (!result.acquired) throw new Error("expected the lock to be acquired");
    const retained = result.value;
    const before = unsafeCalls.length;

    await expect(retained.exec("SELECT 1")).rejects.toBeInstanceOf(
      LockedTransactionClosedError,
    );
    expect(() =>
      (
        retained.db.$client as unknown as { unsafe: (s: string) => unknown }
      ).unsafe("SELECT 1"),
    ).toThrow(LockedTransactionClosedError);
    expect(unsafeCalls).toHaveLength(before);
  });
});
