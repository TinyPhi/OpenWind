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
import { env, RetentionPatchSchema } from "@platform/config";
import { db, tenants } from "@platform/db";
import {
  ProvisionTenantSchema,
  TenantLifecycleError,
  provisionTenant,
  suspendTenant,
  reactivateTenant,
  scheduleTenantDeletion,
  updateTenantRetention,
} from "../../lib/tenant-lifecycle.js";
import { factory } from "./factory.js";
import {
  denyUnlessPlatformOperator,
  logFenceDenied,
} from "../../lib/platform-operator.js";

const TenantIdParamSchema = z.object({ id: z.string().uuid() });

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

// ── PATCH /admin/tenants/:id/retention ────────────────────────────────────────

export const updateTenantRetentionHandlers = factory.createHandlers(
  requireAuth(db),
  requireRole("superadmin"),
  requireIntrospection(),
  // Before validation, so a non-operator learns nothing from a 400 versus a 404.
  async (c, next) => {
    if (denyUnlessPlatformOperator(c.get("auth").tenantId, c.req.path)) {
      return c.json({ error: "NOT_FOUND", message: "Tenant not found" }, 404);
    }
    await next();
  },
  zValidator("param", TenantIdParamSchema),
  zValidator("json", RetentionPatchSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const patch = c.req.valid("json");
    const { userId } = c.get("auth");

    try {
      const { before, after } = await updateTenantRetention(id, userId, patch);
      return c.json({ data: { tenantId: id, before, after } });
    } catch (err) {
      if (err instanceof TenantLifecycleError) {
        if (err.code === "TENANT_NOT_FOUND") {
          return c.json(
            { error: "NOT_FOUND", message: "Tenant not found" },
            404,
          );
        }
        if (err.code === "CONFIRM_SHORTEN_REQUIRED") {
          return c.json(
            {
              error: "CONFIRM_SHORTEN_REQUIRED",
              message:
                "This shortens a retention window, which permanently deletes older data on the next sweep. Resend with confirmShorten: true to proceed.",
              fields: err.meta?.["fields"],
            },
            422,
          );
        }
      }
      throw err;
    }
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
