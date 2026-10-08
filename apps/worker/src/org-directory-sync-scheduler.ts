/**
 * org-directory-sync-scheduler.ts — docs/specs/org-directory.md T5.
 *
 * Owns the two non-admin-triggered sync paths (R7): first-boot auto-seed for
 * a tenant with no org tree yet, and the 24h background re-sync. Mirrors
 * connector-poll-scheduler.ts's shape (setInterval ticker, overlap-guarded,
 * per-tenant reconcile against a live table) rather than a BullMQ repeatable
 * job — there's no per-tenant install/uninstall event to hang a `repeat`
 * option off, so a periodic full-tenant reconcile is the simplest correct
 * fit, same reasoning as that scheduler's own header comment.
 *
 * runOrgDirectorySync (@platform/org-directory) already enforces its own
 * per-tenant advisory lock and is a no-op ("already_running") if a sync is
 * already in flight — including one started by the admin-triggered route —
 * so this reconcile tick never needs to coordinate with that route directly.
 */

import { eq } from "drizzle-orm";
import { db, tenants } from "@platform/db";
import {
  runOrgDirectorySync,
  getSyncStatus,
  ZitadelOrgSourceImporter,
} from "@platform/org-directory";
import { isTenantTrialActive } from "@platform/auth";
import { logger } from "@platform/logger";

const DEFAULT_RECONCILE_INTERVAL_MS = 60 * 60 * 1000; // hourly tick, 24h staleness threshold below
const RESYNC_THRESHOLD_MS = 24 * 60 * 60 * 1000;

const importer = new ZitadelOrgSourceImporter();

export async function reconcile(): Promise<void> {
  try {
    const activeTenants = await db
      .select({ id: tenants.id, trialEndsAt: tenants.trialEndsAt })
      .from(tenants)
      .where(eq(tenants.status, "active"));

    // T12 (docs/specs/multi-org-sandbox.md R6): an expired sandbox trial stops
    // background jobs too, checked fresh against Date.now() every tick --
    // never a precomputed flag.
    const eligibleTenants = activeTenants.filter((tenant) =>
      isTenantTrialActive(tenant.trialEndsAt?.getTime() ?? null),
    );

    // Per-tenant isolation (allSettled) -- one tenant's Zitadel/DB failure
    // must not stop the reconcile tick from reaching the rest, same pattern
    // as due-date-scheduler.ts/alert-scheduler.ts.
    const results = await Promise.allSettled(
      eligibleTenants.map(async (tenant) => {
        const status = await getSyncStatus(tenant.id);
        if (status.syncInProgress) return "skipped" as const;

        const needsSync =
          status.lastSyncedAt === null ||
          (status.staleSinceMs ?? 0) >= RESYNC_THRESHOLD_MS;
        if (!needsSync) return "skipped" as const;

        const result = await runOrgDirectorySync(tenant.id, importer, null);
        return result.status;
      }),
    );

    const failed = results.filter(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult[];
    if (failed.length > 0) {
      logger.error(
        { count: failed.length, errs: failed.map((f) => String(f.reason)) },
        "org-directory-sync-scheduler: some tenants failed to reconcile",
      );
    }
  } catch (err) {
    logger.error(
      { err },
      "org-directory-sync-scheduler: reconcile tick failed",
    );
  }
}

let tickTimer: ReturnType<typeof setInterval> | null = null;
let activeTick: Promise<void> | null = null;

export function startOrgDirectorySyncScheduler(
  intervalMs = DEFAULT_RECONCILE_INTERVAL_MS,
): void {
  if (tickTimer) return;

  activeTick = reconcile().finally(() => {
    activeTick = null;
  });

  tickTimer = setInterval(() => {
    if (activeTick) return;
    activeTick = reconcile().finally(() => {
      activeTick = null;
    });
  }, intervalMs);

  logger.info({ intervalMs }, "org-directory-sync-scheduler started");
}

export async function stopOrgDirectorySyncScheduler(): Promise<void> {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (activeTick) {
    await activeTick;
    activeTick = null;
  }
  logger.info({}, "org-directory-sync-scheduler stopped");
}
