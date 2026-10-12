import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import * as schema from "./schema/index.js";

export type LockedTenantTransactionContext = {
  /**
   * Drizzle bound to the SAME transaction as `exec` and the lock, so writes made
   * through it commit or roll back together with everything else. Its
   * `transaction()` is disabled: a nested call would open a SAVEPOINT.
   */
  db: PostgresJsDatabase<typeof schema>;
  /**
   * Runs raw SQL over the simple query protocol (postgres-js `unsafe()`), so
   * data-modifying CTEs and multi-statement strings work. Takes no parameters.
   */
  exec(sql: string): Promise<void>;
};

export type LockedTenantTransactionOptions = {
  tenantId: string;
  lockKey: string;
  lockSeed: number;
  /** Run the callback, then force a ROLLBACK instead of committing. */
  dryRun?: boolean;
};

export type LockedTenantTransactionResult<T> =
  | { acquired: false }
  | { acquired: true; value: T; rolledBack: boolean };

export class SavepointNotAllowedError extends Error {
  constructor() {
    super(
      "SAVEPOINT_NOT_ALLOWED: nested transactions are disabled inside withLockedTenantTransaction",
    );
    this.name = "SavepointNotAllowedError";
  }
}

export class LockedTransactionClosedError extends Error {
  constructor() {
    super(
      "LOCKED_TRANSACTION_CLOSED: db/exec were used after withLockedTenantTransaction's callback finished",
    );
    this.name = "LockedTransactionClosedError";
  }
}

class DryRunRollback<T> extends Error {
  constructor(readonly value: T) {
    super("dry run rollback");
    this.name = "DryRunRollback";
  }
}

function bindDrizzle(
  client: postgres.Sql,
  tx: postgres.TransactionSql,
  assertOpen: () => void,
): PostgresJsDatabase<typeof schema> {
  // postgres-js builds a transaction handle without the `options` property its
  // types promise, and drizzle()'s constructor writes its value parsers onto
  // `client.options`, so it throws on a bare handle (found by the integration
  // test). Share the parent client's options: for the main client drizzle()
  // already configured them, and the handle parses rows with the parent's
  // options anyway, so this keeps the two consistent.
  Object.defineProperty(tx, "options", { value: client.options });

  // drizzle (and `db.$client`) reach the connection only through this proxy, so
  // a reference kept past the callback fails instead of running on the pool in
  // autocommit as the pool's own role, and `savepoint` is unreachable.
  const guarded = new Proxy(tx, {
    get(target, prop, receiver): unknown {
      if (prop === "savepoint") {
        return (): never => {
          throw new SavepointNotAllowedError();
        };
      }
      if (prop === "unsafe") {
        return (...args: Parameters<typeof target.unsafe>) => {
          assertOpen();
          return target.unsafe(...args);
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
    apply(target, thisArg, args: unknown[]): unknown {
      assertOpen();
      return Reflect.apply(target, thisArg, args) as unknown;
    },
  });

  // The cast is needed because TransactionSql's declared type omits some members
  // of Sql that drizzle's client parameter type requires.
  const db = drizzle({ client: guarded as unknown as postgres.Sql, schema });
  Object.defineProperty(db, "transaction", {
    value: (): Promise<never> => Promise.reject(new SavepointNotAllowedError()),
  });
  return db;
}

/**
 * Runs `fn` inside one postgres-js transaction that holds a transaction-scoped
 * advisory lock and executes as `app_user` under the tenant's RLS context.
 *
 * - The lock is `pg_try_advisory_xact_lock` and is the first statement. It
 *   works whether or not any row exists yet, and it is released at COMMIT or
 *   ROLLBACK, so it is safe behind PgBouncer transaction pooling (unlike a
 *   session lock). Busy => `{ acquired: false }` and `fn` never runs.
 * - A failure in `fn` (or in any statement it runs) rolls everything back and
 *   rethrows the original error.
 * - No SAVEPOINT is used anywhere, so every row written in the transaction,
 *   through `exec` or `db`, carries the transaction's own xid in `xmin` and can
 *   be counted that way. `db.transaction` and `db.$client.savepoint` are
 *   disabled; `exec` is NOT filtered, so a raw `SAVEPOINT`, `COMMIT` or
 *   `RESET ROLE` string would get through. Only pass it SQL that has been
 *   vetted (docs/specs/module-upgrade-workflow.md T3's allowlist lint).
 * - `db` and `exec` throw LockedTransactionClosedError once `fn` has finished.
 */
export async function runLockedTenantTransaction<T>(
  client: postgres.Sql,
  options: LockedTenantTransactionOptions,
  fn: (ctx: LockedTenantTransactionContext) => Promise<T>,
): Promise<LockedTenantTransactionResult<T>> {
  try {
    return await client.begin(
      async (tx): Promise<LockedTenantTransactionResult<T>> => {
        const [row] = await tx<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(
            hashtextextended(${options.lockKey}, ${options.lockSeed})
          ) AS locked
        `;
        if (!row?.locked) return { acquired: false };

        // Switch to app_user so RLS is enforced even when the pool connects as a
        // superuser; same sequence as executeRawInTenantContext.
        await tx`SET LOCAL ROLE app_user`;
        await tx`SELECT set_config('app.tenant_id', ${options.tenantId}, true)`;

        let open = true;
        const assertOpen = (): void => {
          if (!open) throw new LockedTransactionClosedError();
        };
        let value: T;
        try {
          value = await fn({
            db: bindDrizzle(client, tx, assertOpen),
            exec: async (sql) => {
              assertOpen();
              await tx.unsafe(sql);
            },
          });
        } finally {
          open = false;
        }
        if (options.dryRun) throw new DryRunRollback(value);
        return { acquired: true, value, rolledBack: false };
      },
    );
  } catch (err) {
    if (err instanceof DryRunRollback) {
      // The value was produced by `fn: Promise<T>`; DryRunRollback is generic
      // only so it can carry it, and `instanceof` cannot narrow its parameter.
      return { acquired: true, value: err.value as T, rolledBack: true };
    }
    throw err;
  }
}
