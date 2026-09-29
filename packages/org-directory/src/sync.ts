import { and, eq } from "drizzle-orm";
import {
  withTenantContext,
  orgEmployees,
  orgDirectorySyncRuns,
  tenants,
  acquireTenantAdvisoryLock,
} from "@platform/db";
import { logger } from "@platform/logger";
import { buildOrgTree, type PriorEmployee } from "./tree-builder.js";
import type { OrgSourceImporter, SyncResult } from "./types.js";

/**
 * docs/specs/org-directory.md T4 -- the sync engine. Only this module (plus
 * the OrgSourceImporter passed in) touches org_employees/org_directory_sync_runs
 * for writes; T6's query API reads them separately.
 *
 * Concurrency (R2): a session-scoped Postgres advisory lock
 * (acquireTenantAdvisoryLock, @platform/db) is acquired non-blockingly before
 * anything else. If another sync is already running for this tenant,
 * acquisition fails immediately and this returns "already_running" without
 * touching org_directory_sync_runs at all.
 *
 * An earlier version of this function used the org_directory_sync_runs
 * table's own partial unique index (tenant_id) WHERE status = 'running' as
 * the lock, with a time-based staleness reclaim for crashed runs. A security
 * review of that approach found a real race: the 30-minute staleness window
 * was a guess, not a fact, so a second caller could steal the lock out from
 * under a sync that was merely slow (a large org, a sluggish Zitadel API),
 * causing two syncs to run concurrently against the same tenant. The
 * advisory lock fixes this at the root: it's held on a single reserved
 * connection for this function's ENTIRE duration (including the external
 * network fetch, which happens outside any DB transaction -- see below), and
 * Postgres releases it automatically the instant that connection closes, so
 * a real crash unblocks immediately with no timeout guess, and a merely-slow
 * sync is never mistaken for a dead one. org_directory_sync_runs remains a
 * plain status/audit table (read by T6's future getSyncStatus), not the lock
 * itself.
 *
 * Atomicity (R2): the tree rebuild (steps ensure-root / upsert / reparent /
 * delete-removed) all happens inside one transaction, so a failure partway
 * leaves the prior tree fully intact. The external network fetch
 * (importer.fetchAll) deliberately happens OUTSIDE any transaction -- holding
 * a DB transaction open across an HTTP round-trip to the identity provider
 * would block a pool connection for the duration of that call. (This is
 * exactly why the advisory lock, not a transaction-scoped one, is required --
 * see acquireTenantAdvisoryLock's own doc comment.)
 *
 * The "prior tree" (R5) is read as the first statement inside that same
 * transaction, before anything is overwritten -- no separate history table.
 *
 * Ordering note (R4's "cycle-break, then reparent, then root-fallback"): this
 * implementation resolves every node's parent (reparent-on-removal / root
 * fallback) in one pass FIRST, then runs cycle detection over the fully
 * resolved graph, rather than the other way round. That's not merely an
 * equivalent reordering -- it's required for correctness. A reparent can
 * itself create a cycle that didn't exist in the fresh pull (e.g. A's fresh
 * manager is B; B's own manager was removed and B's last-known parent was A
 * -- resolving B's reparent target to A produces an A<->B loop only visible
 * after resolution). Running cycle-break strictly before reparenting, as R4's
 * prose literally orders it, would miss this class of cycle. See
 * tree-builder.test.ts's "reparent can introduce a new cycle" case.
 */

const ADVISORY_LOCK_NAMESPACE = "org-directory-sync";

const FAILED_RESULT: SyncResult = {
  status: "failed",
  syncedAt: null,
  employeeCount: 0,
  cyclesBroken: 0,
  reparented: 0,
};

const ALREADY_RUNNING_RESULT: SyncResult = {
  status: "already_running",
  syncedAt: null,
  employeeCount: 0,
  cyclesBroken: 0,
  reparented: 0,
};

export async function runOrgDirectorySync(
  tenantId: string,
  importer: OrgSourceImporter,
  triggeredBy: string | null = null,
): Promise<SyncResult> {
  const lock = await acquireTenantAdvisoryLock(
    tenantId,
    ADVISORY_LOCK_NAMESPACE,
  );
  if (!lock.acquired) return ALREADY_RUNNING_RESULT;

  try {
    return await runLockedSync(tenantId, importer, triggeredBy);
  } finally {
    // Swallow a release failure rather than letting it mask runLockedSync's
    // real return value (or a real error it threw) -- an unlock query
    // failing on a connection about to be handed back anyway shouldn't hide
    // the sync's actual outcome.
    try {
      await lock.release();
    } catch (releaseErr) {
      logger.error(
        { tenantId, releaseErr },
        "org-directory sync: failed to release tenant advisory lock",
      );
    }
  }
}

async function runLockedSync(
  tenantId: string,
  importer: OrgSourceImporter,
  triggeredBy: string | null,
): Promise<SyncResult> {
  const [inserted] = await withTenantContext(tenantId, (tx) =>
    tx
      .insert(orgDirectorySyncRuns)
      .values({ tenantId, status: "running", triggeredBy })
      .returning({ id: orgDirectorySyncRuns.id }),
  );
  if (!inserted) {
    throw new Error("org-directory sync: sync-run insert returned no row");
  }
  const syncRunId = inserted.id;

  try {
    const fresh = await importer.fetchAll(tenantId);

    const plan = await withTenantContext(tenantId, async (tx) => {
      const [tenant] = await tx
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      if (!tenant) {
        throw new Error(`org-directory sync: tenant ${tenantId} not found`);
      }

      // Prior tree, read before anything below overwrites it (R5).
      const priorRows = await tx
        .select({
          id: orgEmployees.id,
          userId: orgEmployees.userId,
          parentId: orgEmployees.parentId,
        })
        .from(orgEmployees)
        .where(eq(orgEmployees.tenantId, tenantId));
      const priorById = new Map(priorRows.map((r) => [r.id, r]));
      const prior: PriorEmployee[] = priorRows
        .filter((r): r is typeof r & { userId: string } => r.userId !== null)
        .map((r) => ({
          userId: r.userId,
          parentUserId: r.parentId
            ? (priorById.get(r.parentId)?.userId ?? null)
            : null,
        }));

      const built = buildOrgTree(fresh, prior);

      // Ensure the synthetic root exists, keeping its display name current
      // with the tenant's name (R3).
      const [existingRoot] = await tx
        .select({ id: orgEmployees.id })
        .from(orgEmployees)
        .where(
          and(
            eq(orgEmployees.tenantId, tenantId),
            eq(orgEmployees.isRoot, true),
          ),
        )
        .limit(1);
      let rootId: string;
      if (existingRoot) {
        rootId = existingRoot.id;
        await tx
          .update(orgEmployees)
          .set({ name: tenant.name, updatedAt: new Date() })
          .where(
            and(
              eq(orgEmployees.tenantId, tenantId),
              eq(orgEmployees.id, rootId),
            ),
          );
      } else {
        const [createdRoot] = await tx
          .insert(orgEmployees)
          .values({
            tenantId,
            userId: null,
            name: tenant.name,
            isRoot: true,
          })
          .returning({ id: orgEmployees.id });
        if (!createdRoot) {
          throw new Error("org-directory sync: root insert returned no row");
        }
        rootId = createdRoot.id;
      }

      // Pass A: upsert every fresh employee's own fields, parentId deferred.
      // Sequential SELECT-then-insert/update per employee rather than a bulk
      // insert().onConflictDoUpdate() against org_employees_tenant_user_unique
      // -- simpler and safe for the tenant sizes this targets (R8's perf
      // budget is ≤500 employees), but a real scaling limit if a tenant grows
      // much larger. Revisit if sync duration becomes a problem.
      const idByUserId = new Map<string, string>();
      for (const employee of built.employees) {
        const [existing] = await tx
          .select({ id: orgEmployees.id })
          .from(orgEmployees)
          .where(
            and(
              eq(orgEmployees.tenantId, tenantId),
              eq(orgEmployees.userId, employee.userId),
            ),
          )
          .limit(1);
        if (existing) {
          await tx
            .update(orgEmployees)
            .set({
              name: employee.name,
              title: employee.title,
              department: employee.department,
              email: employee.email,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(orgEmployees.tenantId, tenantId),
                eq(orgEmployees.id, existing.id),
              ),
            );
          idByUserId.set(employee.userId, existing.id);
        } else {
          const [created] = await tx
            .insert(orgEmployees)
            .values({
              tenantId,
              userId: employee.userId,
              name: employee.name,
              title: employee.title,
              department: employee.department,
              email: employee.email,
            })
            .returning({ id: orgEmployees.id });
          if (!created) {
            throw new Error(
              `org-directory sync: employee insert returned no row for ${employee.userId}`,
            );
          }
          idByUserId.set(employee.userId, created.id);
        }
      }

      // Pass B: now every fresh employee has a surrogate id, resolve parentId.
      for (const employee of built.employees) {
        const ownId = idByUserId.get(employee.userId);
        if (!ownId) {
          // Every employee in built.employees was just upserted above in the
          // same map, so this can't happen -- guard is here only to avoid a
          // non-null assertion.
          continue;
        }
        const resolvedParentId = employee.parentUserId
          ? (idByUserId.get(employee.parentUserId) ?? rootId)
          : rootId;
        await tx
          .update(orgEmployees)
          .set({ parentId: resolvedParentId })
          .where(
            and(
              eq(orgEmployees.tenantId, tenantId),
              eq(orgEmployees.id, ownId),
            ),
          );
      }

      // Employees present last sync but absent from this pull.
      for (const userId of built.removedUserIds) {
        await tx
          .delete(orgEmployees)
          .where(
            and(
              eq(orgEmployees.tenantId, tenantId),
              eq(orgEmployees.userId, userId),
            ),
          );
      }

      return built;
    });

    const syncedAt = new Date();
    await withTenantContext(tenantId, (tx) =>
      tx
        .update(orgDirectorySyncRuns)
        .set({
          status: "completed",
          completedAt: syncedAt,
          employeeCount: plan.employees.length,
          cyclesBroken: plan.cyclesBroken,
          reparented: plan.reparented,
        })
        .where(
          and(
            eq(orgDirectorySyncRuns.tenantId, tenantId),
            eq(orgDirectorySyncRuns.id, syncRunId),
          ),
        ),
    );

    return {
      status: "completed",
      syncedAt: syncedAt.toISOString(),
      employeeCount: plan.employees.length,
      cyclesBroken: plan.cyclesBroken,
      reparented: plan.reparented,
    };
  } catch (err) {
    logger.error({ tenantId, err }, "org-directory sync failed");
    try {
      await withTenantContext(tenantId, (tx) =>
        tx
          .update(orgDirectorySyncRuns)
          .set({
            status: "failed",
            completedAt: new Date(),
            error: err instanceof Error ? err.message : String(err),
          })
          .where(
            and(
              eq(orgDirectorySyncRuns.tenantId, tenantId),
              eq(orgDirectorySyncRuns.id, syncRunId),
            ),
          ),
      );
    } catch (markErr) {
      logger.error(
        { tenantId, markErr },
        "org-directory sync: failed to mark sync run as failed",
      );
    }
    return FAILED_RESULT;
  }
}
