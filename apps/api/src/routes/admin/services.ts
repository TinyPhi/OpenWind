/**
 * Admin Services CRUD — docs/specs/oncall-routing.md T8, R4, R13.
 *
 * Read (GET) allows agent + admin. Write (POST/PATCH/DELETE) is admin-only.
 * team_id is validated cross-tenant via packages/teams' shared helper
 * (R1d/T44) -- services.team_id has no DB FK (migration 0093's comment).
 */

import { Hono } from "hono";
import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { AuthContext } from "@platform/auth";
import { requireAuth, requireRole } from "@platform/auth";
import { db, withTenantContext, services, teams } from "@platform/db";
import type { DbOrTx } from "@platform/db";
import {
  validateCrossTenantRefs,
  lookupValidIdsInTable,
  type FieldError,
} from "@platform/teams";
import { logger } from "@platform/logger";

type Vars = { Variables: { auth: AuthContext } };

const router = new Hono<Vars>();

router.use("*", requireAuth(db));

const ServiceIdParamSchema = z.object({ id: z.string().uuid() });

const ListServicesQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const CreateServiceSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  teamId: z.string().uuid().optional(),
});

const UpdateServiceSchema = CreateServiceSchema.partial();

// Runs under the caller's withTenantContext tx (not the raw db client) so
// this lookup is defended by RLS as a second layer, not just the explicit
// tenantId filter lookupValidIdsInTable already applies (PR #583-series
// review: an app-layer-only check with no RLS backstop is one accidental
// edit away from a cross-tenant leak).
async function validateTeamRef(
  tx: DbOrTx,
  tenantId: string,
  teamId: string | undefined,
): Promise<{ field: string; message: string }[]> {
  if (!teamId) return [];
  const lookup = lookupValidIdsInTable(
    tx,
    teams,
    teams.id,
    teams.tenantId,
    teams.deletedAt,
    tenantId,
  );
  const errors = await validateCrossTenantRefs(
    [{ fieldName: "teamId", refId: teamId }],
    lookup,
  );
  return errors.map((e: FieldError) => ({
    field: e.field,
    message: e.message,
  }));
}

// GET /admin/services
router.get(
  "/",
  requireRole("agent", "admin"),
  zValidator("query", ListServicesQuerySchema),
  async (c) => {
    const auth = c.get("auth");
    const { cursor, limit } = c.req.valid("query");

    try {
      const result = await withTenantContext(auth.tenantId, async (tx) => {
        const conditions = [
          eq(services.tenantId, auth.tenantId),
          isNull(services.deletedAt),
        ];
        if (cursor) {
          const [cursorRow] = await tx
            .select({ createdAt: services.createdAt })
            .from(services)
            .where(
              and(
                eq(services.id, cursor),
                eq(services.tenantId, auth.tenantId),
              ),
            )
            .limit(1);
          if (cursorRow) {
            conditions.push(gt(services.createdAt, cursorRow.createdAt));
          }
        }
        const rows = await tx
          .select()
          .from(services)
          .where(and(...conditions))
          .orderBy(services.createdAt)
          .limit(limit + 1);

        const hasMore = rows.length > limit;
        const entries = hasMore ? rows.slice(0, limit) : rows;
        const nextCursor =
          hasMore && entries.length > 0
            ? (entries[entries.length - 1]?.id ?? null)
            : null;
        return { entries, nextCursor };
      });

      return c.json({
        data: result.entries,
        meta: {
          hasMore: result.nextCursor !== null,
          nextCursor: result.nextCursor,
        },
      });
    } catch (err: unknown) {
      logger.error({ err, tenantId: auth.tenantId }, "listServices failed");
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// POST /admin/services
router.post(
  "/",
  requireRole("admin"),
  zValidator("json", CreateServiceSchema),
  async (c) => {
    const auth = c.get("auth");
    const input = c.req.valid("json");

    try {
      const result = await withTenantContext(auth.tenantId, async (tx) => {
        const refErrors = await validateTeamRef(
          tx,
          auth.tenantId,
          input.teamId,
        );
        if (refErrors.length > 0) {
          return { status: "invalid" as const, refErrors };
        }
        const [row] = await tx
          .insert(services)
          .values({
            tenantId: auth.tenantId,
            name: input.name,
            description: input.description,
            teamId: input.teamId,
            createdBy: auth.userId,
          })
          .returning();
        return { status: "created" as const, row };
      });

      if (result.status === "invalid") {
        return c.json(
          {
            error: "VALIDATION_ERROR",
            message: "Validation failed",
            fields: result.refErrors,
          },
          422,
        );
      }
      return c.json({ data: result.row }, 201);
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        "cause" in err &&
        err.cause &&
        typeof err.cause === "object" &&
        "code" in err.cause &&
        err.cause.code === "23505"
      ) {
        return c.json(
          {
            error: "CONFLICT",
            message: "A service with this name already exists",
          },
          409,
        );
      }
      logger.error({ err, tenantId: auth.tenantId }, "createService failed");
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// PATCH /admin/services/:id
router.patch(
  "/:id",
  requireRole("admin"),
  zValidator("param", ServiceIdParamSchema),
  zValidator("json", UpdateServiceSchema),
  async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");

    try {
      const result = await withTenantContext(auth.tenantId, async (tx) => {
        const refErrors = await validateTeamRef(
          tx,
          auth.tenantId,
          input.teamId,
        );
        if (refErrors.length > 0) {
          return { status: "invalid" as const, refErrors };
        }
        const [row] = await tx
          .update(services)
          .set({ ...input, updatedAt: new Date() })
          .where(
            and(
              eq(services.id, id),
              eq(services.tenantId, auth.tenantId),
              isNull(services.deletedAt),
            ),
          )
          .returning();
        return {
          status: row ? ("updated" as const) : ("not_found" as const),
          row,
        };
      });

      if (result.status === "invalid") {
        return c.json(
          {
            error: "VALIDATION_ERROR",
            message: "Validation failed",
            fields: result.refErrors,
          },
          422,
        );
      }
      if (result.status === "not_found") {
        return c.json(
          { error: "NOT_FOUND", message: "Service not found" },
          404,
        );
      }
      return c.json({ data: result.row });
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        "cause" in err &&
        err.cause &&
        typeof err.cause === "object" &&
        "code" in err.cause &&
        err.cause.code === "23505"
      ) {
        return c.json(
          {
            error: "CONFLICT",
            message: "A service with this name already exists",
          },
          409,
        );
      }
      logger.error(
        { err, tenantId: auth.tenantId, serviceId: id },
        "updateService failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// DELETE /admin/services/:id — soft-delete.
router.delete(
  "/:id",
  requireRole("admin"),
  zValidator("param", ServiceIdParamSchema),
  async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");

    try {
      const [row] = await withTenantContext(auth.tenantId, (tx) =>
        tx
          .update(services)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(services.id, id),
              eq(services.tenantId, auth.tenantId),
              isNull(services.deletedAt),
            ),
          )
          .returning({ id: services.id }),
      );

      if (!row) {
        return c.json(
          { error: "NOT_FOUND", message: "Service not found" },
          404,
        );
      }
      return c.body(null, 204);
    } catch (err: unknown) {
      logger.error(
        { err, tenantId: auth.tenantId, serviceId: id },
        "deleteService failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

export { router as servicesRouter };
