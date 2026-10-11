import type postgres from "postgres";
import { logger } from "@platform/logger";

type ReservedSql = postgres.ReservedSql;

export interface TenantAdvisoryLock {
  acquired: boolean;
  release(): Promise<void>;
}

export const LOCK_RESERVE_TIMEOUT_MS = 5000;

export class AdvisoryLockPoolExhaustedError extends Error {
  constructor(readonly timeoutMs: number) {
    super(
      `ADVISORY_LOCK_POOL_EXHAUSTED: no lock connection free within ${timeoutMs}ms`,
    );
    this.name = "AdvisoryLockPoolExhaustedError";
  }
}

/**
 * reserve() queues forever once every lock connection is pinned by a holder;
 * bound the wait, and release a connection that arrives after we gave up.
 */
export async function reserveWithTimeout(
  client: { reserve(): Promise<ReservedSql> },
  timeoutMs: number = LOCK_RESERVE_TIMEOUT_MS,
): Promise<ReservedSql> {
  const pending = client.reserve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AdvisoryLockPoolExhaustedError(timeoutMs)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([pending, timeout]);
  } catch (err) {
    if (err instanceof AdvisoryLockPoolExhaustedError) {
      pending.then(
        (late) => late.release(),
        () => {},
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Session-scoped advisory lock keyed by (namespace, tenantId), held on a
 * single reserved connection across multiple statements AND transactions --
 * unlike pg_advisory_xact_lock (see automation-engine/src/executor.ts), this
 * survives an external network call made between DB operations, because it
 * isn't tied to any one transaction's lifetime. It IS tied to the reserved
 * connection's lifetime: if the holding process crashes, Postgres releases
 * the lock the moment that connection drops -- no stale-lock timeout guess
 * needed, unlike a row-flag-based lock (docs/specs/org-directory.md T4's
 * runOrgDirectorySync -- a security review of that PR found the row-based
 * stale-reclaim approach could steal a still-healthy sync's lock out from
 * under it; this replaced it).
 *
 * The reserved connection MUST pin one Postgres backend. Behind PgBouncer
 * transaction pooling it does not: two callers can both be granted the lock
 * on the same backend (advisory locks are re-entrant per session), and an
 * unlock can land on a different backend and leak the lock (#752). The
 * caller therefore hands in a reserve() from a direct connection; the pid
 * and unlock-result checks below make a mis-wired topology loud.
 *
 * Non-blocking (pg_try_advisory_lock): if another session already holds the
 * lock for this key, `acquired` is false and the reserved connection is
 * released immediately -- callers should treat that as "already in progress"
 * and not retry in a loop.
 */
export async function acquireAdvisoryLock(
  reserve: () => Promise<ReservedSql>,
  tenantId: string,
  namespace: string,
  seed: number,
): Promise<TenantAdvisoryLock> {
  const reserved = await reserve();
  const key = `${namespace}:${tenantId}`;
  let row: { locked: boolean; pid: number } | undefined;
  try {
    [row] = await reserved<{ locked: boolean; pid: number }[]>`
      SELECT pg_try_advisory_lock(hashtextextended(${key}, ${seed})) AS locked,
             pg_backend_pid() AS pid
    `;
  } catch (err) {
    // Never leak the reserved connection -- a blip between reserve() and this
    // query must still hand the connection back to the pool.
    reserved.release();
    throw err;
  }
  if (!row?.locked) {
    reserved.release();
    return { acquired: false, release: async () => {} };
  }
  const acquirePid = row.pid;
  let released = false;
  return {
    acquired: true,
    release: async () => {
      if (released) return;
      released = true;
      try {
        const rows = await reserved<{ unlocked: boolean; pid: number }[]>`
          SELECT pg_advisory_unlock(hashtextextended(${key}, ${seed})) AS unlocked,
                 pg_backend_pid() AS pid
        `;
        const result: { unlocked: boolean; pid: number } | undefined = rows[0];
        const switchedBackend = result?.pid !== acquirePid;
        if (switchedBackend || !result.unlocked) {
          logger.error(
            {
              tenantId,
              namespace,
              acquirePid,
              releasePid: result?.pid,
              unlocked: result?.unlocked,
            },
            switchedBackend
              ? "advisory lock anomaly: unlock ran on a different backend than the lock -- the lock connection is probably behind a transaction pooler; set DATABASE_DIRECT_URL"
              : "advisory lock anomaly: pg_advisory_unlock returned false -- this session did not hold the lock",
          );
        }
      } catch (err) {
        logger.error(
          { tenantId, namespace, acquirePid, error: String(err) },
          "advisory lock anomaly: release failed -- the lock may stay held until its backend closes",
        );
        throw err;
      } finally {
        reserved.release();
      }
    },
  };
}
