/**
 * Admin tenant lifecycle routes — superadmin only.
 *
 * Mutating routes (POST, PATCH, DELETE) require live token introspection to
 * prevent stolen-JWT attacks on destructive operations.
 * Read-only routes (GET) are guarded by requireRole only — no Zitadel
 * round-trip needed for reads.
 */

import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import {
  requireAuth,
  requireRole,
  requireIntrospection,
  setTenantRateLimitOverride,
} from "@platform/auth";
import {
  env,
  UpdateTenantRetentionSchema,
  resolveRetentionPolicy,
} from "@platform/config";
import { db, tenants, withTenantContext } from "@platform/db";
import { writeAuditEntry } from "@platform/audit";
import {
  ProvisionTenantSchema,
  TenantLifecycleError,
  provisionTenant,
  suspendTenant,
  reactivateTenant,
  scheduleTenantDeletion,
} from "../../lib/tenant-lifecycle.js";
import { factory } from "./factory.js";
import {
  denyUnlessPlatformOperator,
  logFenceDenied,
} from "../../lib/platform-operator.js";

const TenantIdParamSchema = z.object({ id: z.guid() });

const TENANT_COLUMNS = {
  id: tenants.id,
  name: tenants.name,
  slug: tenants.slug,
  plan: tenants.plan,
  status: tenants.status,
  suspendedAt: tenants.suspendedAt,
  deletionScheduledAt: tenants.deletionScheduledAt,
  createdAt: tenants.createdAt,
  updatedAt: tenants.updatedAt,
} as const;

// ── GET /admin/tenants ────────────────────────────────────────────────────────

const TenantStatusEnum = z.enum([
  "provisioning",
  "active",
  "suspended",
  "deleted",
  "purged",
]);

const ListTenantsQuerySchema = z.object({
  status: TenantStatusEnum.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const listTenantsHandlers = factory.createHandlers(
  requireAuth(db),
  requireRole("superadmin"),
  zValidator("query", ListTenantsQuerySchema),
  async (c) => {
    if (denyUnlessPlatformOperator(c.get("auth").tenantId, c.req.path)) {
      return c.json({ error: "NOT_FOUND", message: "Tenant not found" }, 404);
    }
    const { status, limit, offset } = c.req.valid("query");

    const rows = await db
      .select(TENANT_COLUMNS)
      .from(tenants)
      .where(status !== undefined ? eq(tenants.status, status) : undefined)
      .orderBy(asc(tenants.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({ data: rows });
  },
);

// ── GET /admin/tenants/:id ────────────────────────────────────────────────────

export const getTenantHandlers = factory.createHandlers(
  requireAuth(db),
  requireRole("superadmin"),
  zValidator("param", TenantIdParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    if (denyUnlessPlatformOperator(c.get("auth").tenantId, c.req.path)) {
      return c.json({ error: "NOT_FOUND", message: "Tenant not found" }, 404);
    }

    const [row] = await db
      .select(TENANT_COLUMNS)
      .from(tenants)
      .where(eq(tenants.id, id))
      .limit(1);

    if (!row) {
      return c.json({ error: "NOT_FOUND", message: "Tenant not found" }, 404);
    }
    return c.json({ data: row });
  },
);

// ── POST /admin/tenants ───────────────────────────────────────────────────────

export const createTenantHandlers = factory.createHandlers(
  requireAuth(db),
  requireRole("superadmin"),
  requireIntrospection(),
  zValidator("json", ProvisionTenantSchema),
  async (c) => {
    const input = c.req.valid("json");
    const { userId } = c.get("auth");

    try {
      const result = await provisionTenant(input, userId);
      return c.json({ data: result }, 201);
    } catch (err) {
      if (err instanceof TenantLifecycleError && err.code === "SLUG_TAKEN") {
        return c.json(
          {
            error: "CONFLICT",
            message: "A tenant with this slug already exists",
          },
          409,
        );
      }
      throw err;
    }
  },
);

// ── PATCH /admin/tenants/:id/suspend ─────────────────────────────────────────

export const suspendTenantHandlers = factory.createHandlers(
  requireAuth(db),
  requireRole("superadmin"),
  requireIntrospection(),
  zValidator("param", TenantIdParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const { userId } = c.get("auth");
    if (denyUnlessPlatformOperator(c.get("auth").tenantId, c.req.path)) {
      return c.json({ error: "NOT_FOUND", message: "Tenant not found" }, 404);
    }

    try {
      await suspendTenant(id, userId);
      return c.json({ data: { tenantId: id, status: "suspended" } });
    } catch (err) {
      if (err instanceof TenantLifecycleError) {
        if (err.code === "TENANT_NOT_FOUND") {
          return c.json(
            { error: "NOT_FOUND", message: "Tenant not found" },
            404,
          );
        }
        if (err.code === "INVALID_TRANSITION") {
          return c.json(
            {
              error: "CONFLICT",
              message: "Tenant cannot be suspended from its current state",
            },
            409,
          );
        }
      }
      throw err;
    }
  },
);

// ── PATCH /admin/tenants/:id/reactivate ──────────────────────────────────────

export const reactivateTenantHandlers = factory.createHandlers(
  requireAuth(db),
  requireRole("superadmin"),
  requireIntrospection(),
  zValidator("param", TenantIdParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const { userId } = c.get("auth");
    if (denyUnlessPlatformOperator(c.get("auth").tenantId, c.req.path)) {
      return c.json({ error: "NOT_FOUND", message: "Tenant not found" }, 404);
    }

    try {
      await reactivateTenant(id, userId);
      return c.json({ data: { tenantId: id, status: "active" } });
    } catch (err) {
      if (err instanceof TenantLifecycleError) {
        if (err.code === "TENANT_NOT_FOUND") {
          return c.json(
            { error: "NOT_FOUND", message: "Tenant not found" },
            404,
          );
        }
        if (err.code === "INVALID_TRANSITION") {
          return c.json(
            {
              error: "CONFLICT",
              message: "Only suspended tenants can be reactivated",
            },
            409,
          );
        }
      }
      throw err;
    }
  },
);

// ── PATCH /admin/tenants/:id/rate-limit ──────────────────────────────────────
// ADR-012 Phase G, spec R2 -- per-tenant rate-limit ceiling override,
// stored in tenants.config (see @platform/auth's tenant-rate-limit.ts).
// No live introspection here (unlike suspend/reactivate/delete): this is a
// tunable, not a destructive lifecycle transition.

const RateLimitPatchSchema = z.object({
  ratePerMin: z.number().int().positive().nullable(),
});

export const updateTenantRateLimitHandlers = factory.createHandlers(
  requireAuth(db),
  requireRole("superadmin"),
  zValidator("param", TenantIdParamSchema),
  zValidator("json", RateLimitPatchSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const { ratePerMin } = c.req.valid("json");
    const authTenantId = c.get("auth").tenantId;
    // With a platform org, only its callers may proceed. Without one, dev/test lets a tenant adjust
    // only itself and production refuses everyone.
    const denied = env.PLATFORM_ORG_ID
      ? authTenantId !== env.PLATFORM_ORG_ID
      : env.NODE_ENV === "production" || authTenantId !== id;
    if (denied) {
      logFenceDenied(authTenantId, c.req.path);
      return c.json({ error: "NOT_FOUND", message: "Tenant not found" }, 404);
    }

    const [row] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, id))
      .limit(1);
    if (!row) {
      return c.json({ error: "NOT_FOUND", message: "Tenant not found" }, 404);
    }

    await setTenantRateLimitOverride(db, id, ratePerMin);
    return c.json({ data: { tenantId: id, ratePerMin } });
  },
);

// ── PATCH /admin/tenants/:id/retention ──────────────────────────────────────
// Issue #637: Configurable per-tenant retention policy updates.
// Allows superadmins in the platform organization to configure noise, comment,
// and evidence retention windows, or set/clear legal holds for a tenant.
// Guarded by confirmShorten to prevent accidental immediate data purging.

export const updateTenantRetentionHandlers = factory.createHandlers(
  requireAuth(db),
  requireRole("superadmin"),
  requireIntrospection(),
  async (c, next) => {
    if (denyUnlessPlatformOperator(c.get("auth").tenantId, c.req.path)) {
      return c.json({ error: "NOT_FOUND", message: "Tenant not found" }, 404);
    }
    await next();
    return;
  },
  zValidator("param", TenantIdParamSchema),
  zValidator("json", UpdateTenantRetentionSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const { userId } = c.get("auth");

    const result = await withTenantContext(id, async (tx) => {
      const [existing] = await tx
        .select({ id: tenants.id, config: tenants.config })
        .from(tenants)
        .where(eq(tenants.id, id))
        .for("update");

      if (!existing) {
        return { notFound: true } as const;
      }

      const currentConfig =
        (existing.config as Record<string, unknown> | null) ?? {};
      const currentPolicy = resolveRetentionPolicy(currentConfig);

      const nextConfig = { ...currentConfig };

      if (input.retention_days === null) {
        delete nextConfig.retention_days;
      } else if (input.retention_days !== undefined) {
        nextConfig.retention_days = input.retention_days;
      }

      if (input.retention_comment_days === null) {
        delete nextConfig.retention_comment_days;
      } else if (input.retention_comment_days !== undefined) {
        nextConfig.retention_comment_days = input.retention_comment_days;
      }

      if (input.retention_evidence_days === null) {
        delete nextConfig.retention_evidence_days;
      } else if (input.retention_evidence_days !== undefined) {
        nextConfig.retention_evidence_days = input.retention_evidence_days;
      }

      if (input.retention_hold === null) {
        delete nextConfig.retention_hold;
      } else if (input.retention_hold !== undefined) {
        nextConfig.retention_hold = input.retention_hold;
      }

      const nextPolicy = resolveRetentionPolicy(nextConfig);

      const isShortening =
        nextPolicy.noiseDays < currentPolicy.noiseDays ||
        nextPolicy.commentDays < currentPolicy.commentDays ||
        nextPolicy.evidenceDays < currentPolicy.evidenceDays;

      if (
        isShortening &&
        env.RETENTION_REQUIRE_SHORTEN_CONFIRM &&
        !input.confirmShorten
      ) {
        return { confirmShortenRequired: true } as const;
      }

      await tx
        .update(tenants)
        .set({
          config: nextConfig,
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, id));

      await writeAuditEntry(tx, {
        tenantId: id,
        actorId: userId,
        actorType: "user",
        resourceType: "tenant",
        resourceId: id,
        action: "updated",
        beforeSnapshot: {
          retention_days: currentPolicy.noiseDays,
          retention_comment_days: currentPolicy.commentDays,
          retention_evidence_days: currentPolicy.evidenceDays,
          retention_hold: currentPolicy.hold,
        },
        afterSnapshot: {
          retention_days: nextPolicy.noiseDays,
          retention_comment_days: nextPolicy.commentDays,
          retention_evidence_days: nextPolicy.evidenceDays,
          retention_hold: nextPolicy.hold,
        },
        metadata: {
          type: "retention_policy_update",
          confirmShorten: Boolean(input.confirmShorten),
        },
      });

      return { success: true, nextPolicy } as const;
    });

    if ("notFound" in result) {
      return c.json({ error: "NOT_FOUND", message: "Tenant not found" }, 404);
    }

    if ("confirmShortenRequired" in result) {
      return c.json(
        {
          error: "CONFIRM_SHORTEN_REQUIRED",
          message:
            "Shortening retention window is irreversible and will permanently delete data during the next sweep. Set confirmShorten to true to confirm.",
        },
        400,
      );
    }

    return c.json({
      data: {
        tenantId: id,
        retention_days: result.nextPolicy.noiseDays,
        retention_comment_days: result.nextPolicy.commentDays,
        retention_evidence_days: result.nextPolicy.evidenceDays,
        retention_hold: result.nextPolicy.hold,
      },
    });
  },
);

// ── DELETE /admin/tenants/:id ─────────────────────────────────────────────────

const ScheduleDeletionSchema = z.object({
  // G3: min(1) — zero-day grace period would immediately and irreversibly destroy data.
  delayDays: z.number().int().min(1).max(365).default(30),
});

export const deleteTenantHandlers = factory.createHandlers(
  requireAuth(db),
  requireRole("superadmin"),
  requireIntrospection(),
  zValidator("param", TenantIdParamSchema),
  zValidator("json", ScheduleDeletionSchema.partial()),
  async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const { userId } = c.get("auth");
    if (denyUnlessPlatformOperator(c.get("auth").tenantId, c.req.path)) {
      return c.json({ error: "NOT_FOUND", message: "Tenant not found" }, 404);
    }

    try {
      const result = await scheduleTenantDeletion(id, userId, body.delayDays);
      return c.json({ data: { tenantId: id, status: "deleted", ...result } });
    } catch (err) {
      if (err instanceof TenantLifecycleError) {
        if (err.code === "TENANT_NOT_FOUND") {
          return c.json(
            { error: "NOT_FOUND", message: "Tenant not found" },
            404,
          );
        }
        if (err.code === "INVALID_TRANSITION") {
          return c.json(
            {
              error: "CONFLICT",
              message: "Tenant is already deleted or purged",
            },
            409,
          );
        }
      }
      throw err;
    }
  },
);
