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
import { requireAuth, requireRole, requireIntrospection } from "@platform/auth";
import { db, tenants } from "@platform/db";
import {
  ProvisionTenantSchema,
  TenantLifecycleError,
  provisionTenant,
  suspendTenant,
  reactivateTenant,
  scheduleTenantDeletion,
} from "../../lib/tenant-lifecycle.js";
import { factory } from "./factory.js";

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
