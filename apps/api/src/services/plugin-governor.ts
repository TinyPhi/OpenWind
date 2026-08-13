/**
 * R5: soft governor limits for plugin code — query timeout + row ceiling (via the
 * wrapped DB client below) and job execution timeout (withJobTimeout). Both are
 * soft in v1: a breach is logged and callers still get a result — see
 * docs/specs/plugin-system.md R5 for why (first-party trust means a breach is
 * more likely a bug than an attack, and this is the item flagged to harden first
 * if the trust tier ever opens up).
 */

import { sql } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import { logger } from "@platform/logger";

export const DEFAULT_QUERY_TIMEOUT_MS = 5_000;
export const DEFAULT_ROW_CEILING = 10_000;
export const DEFAULT_JOB_TIMEOUT_MS = 30_000;

export interface GovernorBreach {
  tenantId: string;
  pluginId: string;
  kind: "governor_limit_breach";
  detail: Record<string, unknown>;
}

/**
 * Sets a transaction-local statement_timeout so a runaway plugin query is
 * cancelled server-side (not just abandoned client-side) — this must run inside
 * the same transaction as the plugin's own role switch (R4-addendum), so the
 * timeout is scoped to that plugin's work, not the whole connection.
 */
export async function applyQueryGovernor(
  tx: DbOrTx,
  timeoutMs: number = DEFAULT_QUERY_TIMEOUT_MS,
): Promise<void> {
  await tx.execute(sql`SET LOCAL statement_timeout = ${timeoutMs}`);
}

/**
 * Checks a plugin query's resulting row count against the ceiling afterward.
 * Unlike the timeout above (which prevents the query from ever finishing), the
 * row ceiling is deliberately post-hoc and non-blocking (R5): the caller still
 * gets its data, but a breach is reported so it can be logged. Pure/sync — no
 * DB access here, just the comparison; kept as its own function so the call
 * site can log with tenantId/pluginId context this module doesn't have.
 */
export function checkRowCeiling(
  rowCount: number,
  ceiling: number = DEFAULT_ROW_CEILING,
): GovernorBreach["detail"] | null {
  if (rowCount <= ceiling) return null;
  return { rowCount, ceiling };
}

/**
 * Runs a plugin job with a soft timeout: if `fn` hasn't settled by `timeoutMs`,
 * `onBreach` fires immediately (for logging), but `fn` is never cancelled — it's
 * still allowed to finish and its result/error is still what this function
 * resolves/rejects with. This is intentionally different from the query timeout
 * above, which does cancel server-side; R5 treats job execution as soft-only in
 * v1 because there's no safe, generic way to cancel arbitrary plugin job code.
 */
export async function withJobTimeout<T>(
  fn: () => Promise<T>,
  opts: {
    timeoutMs?: number;
    onBreach: (elapsedMs: number) => void;
  },
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  const start = Date.now();

  const timer = setTimeout(() => {
    const elapsedMs = Date.now() - start;
    logger.warn(
      { elapsedMs, timeoutMs },
      "plugin-governor: job exceeded soft timeout but was allowed to finish",
    );
    opts.onBreach(elapsedMs);
  }, timeoutMs);

  try {
    return await fn();
  } finally {
    clearTimeout(timer);
  }
}
