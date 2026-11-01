import { env } from "@platform/config";
import type { SupersetErasureMode } from "@platform/config";
import { logger } from "@platform/logger";
import { getRedis } from "./index.js";

/**
 * The worker's last Superset erasure self-check (#1137), kept in Redis so the API and the tenant
 * purge can act on what Superset itself reports instead of on their own copy of
 * SUPERSET_OAUTH_CLIENT_ID. Written by the worker's repeatable self-check job
 * (apps/worker/src/superset-erasure-selfcheck.ts) every SUPERSET_SELFCHECK_INTERVAL_MINUTES (15); it
 * expires after SUPERSET_SELFCHECK_TTL_MINUTES (30), so a worker that stops checking leaves the answer
 * "unverified".
 */
export const SUPERSET_SELFCHECK_KEY = "ops:superset-erasure:selfcheck";

/** How long a stored result stays fresh (SUPERSET_SELFCHECK_TTL_MINUTES). */
export function supersetSelfcheckTtlSeconds(): number {
  return env.SUPERSET_SELFCHECK_TTL_MINUTES * 60;
}

export const SUPERSET_SELFCHECK_OUTCOMES = [
  "ok",
  "mismatch",
  "smoke_failed",
  "unreachable",
  "skipped",
] as const;
export type SupersetSelfcheckOutcome =
  (typeof SUPERSET_SELFCHECK_OUTCOMES)[number];

export interface SupersetSelfcheckResult {
  /** Epoch milliseconds. */
  checkedAt: number;
  outcome: SupersetSelfcheckOutcome;
  /** What Superset reported; null when it could not be asked. */
  stage2: boolean | null;
  /** Superset's report and this service's own setting (SUPERSET_DEPLOYMENT, SUPERSET_OAUTH_CLIENT_ID) disagree. */
  mismatch: boolean;
}

export async function writeSupersetSelfcheck(
  result: SupersetSelfcheckResult,
): Promise<void> {
  await getRedis().set(
    SUPERSET_SELFCHECK_KEY,
    JSON.stringify(result),
    "EX",
    supersetSelfcheckTtlSeconds(),
  );
}

/** Narrows untrusted Redis content; anything malformed is treated as no result. */
export function parseSupersetSelfcheck(
  raw: string | null,
): SupersetSelfcheckResult | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const outcome = SUPERSET_SELFCHECK_OUTCOMES.find((o) => o === v.outcome);
  if (
    typeof v.checkedAt !== "number" ||
    !Number.isFinite(v.checkedAt) ||
    !outcome ||
    typeof v.mismatch !== "boolean" ||
    (v.stage2 !== null && typeof v.stage2 !== "boolean")
  ) {
    return null;
  }
  return {
    checkedAt: v.checkedAt,
    outcome,
    stage2: v.stage2,
    mismatch: v.mismatch,
  };
}

/** The last self-check, or null when there is none or Redis cannot be read (never throws). */
export async function readSupersetSelfcheck(): Promise<SupersetSelfcheckResult | null> {
  try {
    return parseSupersetSelfcheck(await getRedis().get(SUPERSET_SELFCHECK_KEY));
  } catch (err) {
    logger.warn({ err }, "superset self-check result could not be read");
    return null;
  }
}

export interface ResolvedSupersetErasureMode {
  /** What to do. "full" also when Superset reports Stage 2 on and this service's env says not. */
  mode: SupersetErasureMode;
  /**
   * False when this service's own setting is "cache-only" (deployment on, no Stage 2) and there is no
   * fresh answer from Superset that Stage 2 is off: a flushed cache is then not known to be enough.
   */
  verified: boolean;
  /** Superset reports Stage 2 on while this service's setting does not say "full". */
  overridden: boolean;
}

/**
 * Combines this service's own mode with the last self-check, failing closed (#1137):
 * - Superset reports Stage 2 on: "full", whatever the local env says.
 * - Local "full": "full"; the job is durable and retries until Superset answers.
 * - Local "off" (SUPERSET_DEPLOYMENT=off): no Superset expected, kept ("disabled" is not shown as
 *   success). A fresh report of Stage 2 on is the only thing that overrides it.
 * - Local "cache-only": verified only by a fresh answer that Stage 2 is off.
 */
export function resolveSupersetErasureMode(
  local: SupersetErasureMode,
  check: SupersetSelfcheckResult | null,
  now: number = Date.now(),
): ResolvedSupersetErasureMode {
  const fresh =
    check !== null &&
    now - check.checkedAt <= supersetSelfcheckTtlSeconds() * 1000 &&
    check.checkedAt <= now + 60_000
      ? check
      : null;
  if (fresh?.stage2 === true) {
    return { mode: "full", verified: true, overridden: local !== "full" };
  }
  if (local === "full")
    return { mode: "full", verified: true, overridden: false };
  if (local === "off")
    return { mode: "off", verified: true, overridden: false };
  return {
    mode: "cache-only",
    verified: fresh?.stage2 === false,
    overridden: false,
  };
}
