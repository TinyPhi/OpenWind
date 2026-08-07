/**
 * Tenant lifecycle service.
 *
 * State machine:  provisioning → active → suspended → deleted → (purged by worker)
 *
 * All transitions are written to admin_audit_log.  The tenant-purge BullMQ
 * worker runs after deletion_scheduled_at and hard-deletes all tenant data.
 */

import { Queue } from "bullmq";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, tenants } from "@platform/db";
import { writeAuditEntry } from "@platform/audit";
import { logger } from "@platform/logger";
import { connection } from "./redis.js";
import { invalidateTenantStatusCache } from "@platform/auth";
import { ModuleService } from "../services/module-service.js";

// One Queue instance per process for enqueuing — the worker holds the Worker.
const tenantPurgeQueue = new Queue("tenant-purge", { connection });

// ── Schemas ───────────────────────────────────────────────────────────────────

export const ProvisionTenantSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric with hyphens"),
  plan: z.enum(["standard", "professional", "enterprise"]).default("standard"),
  config: z.record(z.unknown()).optional(),
});

export type ProvisionTenantInput = z.infer<typeof ProvisionTenantSchema>;

// ── Errors ────────────────────────────────────────────────────────────────────

export class TenantLifecycleError extends Error {
  constructor(
    public readonly code:
      | "TENANT_NOT_FOUND"
      | "INVALID_TRANSITION"
      | "SLUG_TAKEN",
    public readonly meta?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "TenantLifecycleError";
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEFAULT_DELETION_DELAY_DAYS = 30;

/**
 * Load a tenant by ID for multi-state transitions (e.g. active | suspended).
 * Single-state transitions use atomic conditional UPDATE directly.
 */
async function loadTenant(
  tenantId: string,
): Promise<typeof tenants.$inferSelect> {
  const [row] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!row) throw new TenantLifecycleError("TENANT_NOT_FOUND", { tenantId });
  return row;
}

function assertTransition(
  current: string,
  allowed: string[],
  tenantId: string,
): void {
  if (!allowed.includes(current)) {
    throw new TenantLifecycleError("INVALID_TRANSITION", {
      tenantId,
      currentStatus: current,
      allowedFrom: allowed,
    });
  }
}

/**
 * Called when a conditional UPDATE returned 0 rows: SELECT to distinguish
 * TENANT_NOT_FOUND from INVALID_TRANSITION (concurrent modification).
 */
async function diagnoseNoUpdate(tenantId: string): Promise<never> {
  const [row] = await db
    .select({ status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!row) throw new TenantLifecycleError("TENANT_NOT_FOUND", { tenantId });
  throw new TenantLifecycleError("INVALID_TRANSITION", {
    tenantId,
    currentStatus: row.status,
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a new tenant and immediately activate it.
 * Uses INSERT ON CONFLICT DO NOTHING to handle slug races atomically.
 *
 * #163: core-module installation (ADR-005) is NOT wrapped in the tenant
 * INSERT's transaction — ModuleService.installModule opens its own
 * per-seed-file transactions via executeRawInTenantContext, so a single
 * outer DB transaction spanning tenant creation + N module installs isn't
 * practical without threading a shared tx handle through the whole seed
 * pipeline. Instead this uses a compensating design: the tenant row commits
 * first (it's always valid on its own — a tenant with zero modules installed
 * is a legitimate, recoverable state, not corruption), then each core module
 * is attempted independently via installCoreModules, which never lets one
 * module's failure block the others. #161 made every standard module's seed
 * SQL idempotent, so any module reported in `failed` can be retried safely
 * via `POST /modules/:slug/install` without redoing the whole tenant.
 */
export async function provisionTenant(
  input: ProvisionTenantInput,
  actorId: string,
): Promise<{
  id: string;
  slug: string;
  modules: { succeeded: string[]; failed: { slug: string; error: string }[] };
}> {
  const parsed = ProvisionTenantSchema.parse(input);
  const now = new Date();

  // M4: single INSERT with ON CONFLICT DO NOTHING — catches the slug uniqueness
  // race that a SELECT-then-INSERT misses under concurrent provisioning.
  const [row] = await db
    .insert(tenants)
    .values({
      name: parsed.name,
      slug: parsed.slug,
      plan: parsed.plan,
      status: "active",
      config: parsed.config ?? {},
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: tenants.id, slug: tenants.slug });

  if (!row) {
    throw new TenantLifecycleError("SLUG_TAKEN", { slug: parsed.slug });
  }

  await writeAuditEntry(db, {
    tenantId: row.id,
    actorId,
    actorType: "user",
    resourceType: "tenant",
    resourceId: row.id,
    action: "created",
    afterSnapshot: { name: parsed.name, slug: parsed.slug, plan: parsed.plan },
  });

  const moduleResult = await ModuleService.installCoreModules(row.id);
  if (moduleResult.failed.length > 0) {
    logger.error(
      { tenantId: row.id, ...moduleResult },
      "tenant: provisioned with one or more core modules failing to install",
    );
  }

  logger.info(
    { tenantId: row.id, slug: row.slug, actorId, ...moduleResult },
    "tenant: provisioned",
  );
  return { id: row.id, slug: row.slug, modules: moduleResult };
}

/**
 * Suspend a tenant: blocks API access immediately (auth middleware cache
 * invalidated), preserves all data.
 *
 * Allowed from: active
 * G2: uses atomic conditional UPDATE to prevent duplicate audit entries on
 * concurrent calls.
 */
export async function suspendTenant(
  tenantId: string,
  actorId: string,
): Promise<void> {
  const now = new Date();
  const [updated] = await db
    .update(tenants)
    .set({ status: "suspended", suspendedAt: now, updatedAt: now })
    .where(and(eq(tenants.id, tenantId), eq(tenants.status, "active")))
    .returning({ id: tenants.id });

  if (!updated) return diagnoseNoUpdate(tenantId);

  invalidateTenantStatusCache(tenantId);

  await writeAuditEntry(db, {
    tenantId,
    actorId,
    actorType: "user",
    resourceType: "tenant",
    resourceId: tenantId,
    action: "transitioned",
    beforeSnapshot: { status: "active" },
    afterSnapshot: { status: "suspended" },
  });

  logger.info({ tenantId, actorId }, "tenant: suspended");
}

/**
 * Reactivate a suspended tenant.
 *
 * Allowed from: suspended
 * G2: uses atomic conditional UPDATE.
 */
export async function reactivateTenant(
  tenantId: string,
  actorId: string,
): Promise<void> {
  const now = new Date();
  const [updated] = await db
    .update(tenants)
    .set({ status: "active", suspendedAt: null, updatedAt: now })
    .where(and(eq(tenants.id, tenantId), eq(tenants.status, "suspended")))
    .returning({ id: tenants.id });

  if (!updated) return diagnoseNoUpdate(tenantId);

  invalidateTenantStatusCache(tenantId);

  await writeAuditEntry(db, {
    tenantId,
    actorId,
    actorType: "user",
    resourceType: "tenant",
    resourceId: tenantId,
    action: "transitioned",
    beforeSnapshot: { status: "suspended" },
    afterSnapshot: { status: "active" },
  });

  logger.info({ tenantId, actorId }, "tenant: reactivated");
}

/**
 * Schedule a tenant for GDPR deletion.
 *
 * Sets status → 'deleted' immediately (blocks API access) and enqueues a
 * BullMQ purge job to hard-delete all data after `delayDays` (default 30,
 * minimum 1 — enforced at the route layer).
 *
 * Allowed from: active | suspended
 * G2: loadTenant captures prevStatus for the audit log; the conditional UPDATE
 * prevents concurrent calls from both writing audit entries.
 */
export async function scheduleTenantDeletion(
  tenantId: string,
  actorId: string,
  delayDays = DEFAULT_DELETION_DELAY_DAYS,
): Promise<{ deletionScheduledAt: Date }> {
  const tenant = await loadTenant(tenantId);
  assertTransition(tenant.status, ["active", "suspended"], tenantId);

  const delayMs = delayDays * 24 * 60 * 60 * 1000;
  const deletionScheduledAt = new Date(Date.now() + delayMs);
  const now = new Date();

  const [updated] = await db
    .update(tenants)
    .set({ status: "deleted", deletionScheduledAt, updatedAt: now })
    .where(
      and(
        eq(tenants.id, tenantId),
        inArray(tenants.status, ["active", "suspended"]),
      ),
    )
    .returning({ id: tenants.id });

  if (!updated) {
    // Concurrent modification — status changed between loadTenant and this UPDATE
    throw new TenantLifecycleError("INVALID_TRANSITION", {
      tenantId,
      currentStatus: tenant.status,
    });
  }

  invalidateTenantStatusCache(tenantId);

  // Enqueue the purge job — runs after the scheduled delay
  await tenantPurgeQueue.add(
    "purge",
    { tenantId },
    {
      delay: delayMs,
      jobId: `tenant-purge-${tenantId}`, // deduplication key
      attempts: 5,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: { age: 7 * 24 * 3600 },
      removeOnFail: false, // keep failed purge jobs for inspection
    },
  );

  await writeAuditEntry(db, {
    tenantId,
    actorId,
    actorType: "user",
    resourceType: "tenant",
    resourceId: tenantId,
    action: "deleted",
    beforeSnapshot: { status: tenant.status },
    afterSnapshot: {
      status: "deleted",
      deletionScheduledAt: deletionScheduledAt.toISOString(),
    },
    metadata: { delayDays },
  });

  logger.info(
    { tenantId, actorId, deletionScheduledAt, delayDays },
    "tenant: deletion scheduled",
  );

  return { deletionScheduledAt };
}
