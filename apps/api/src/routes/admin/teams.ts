/**
 * Admin Teams CRUD — docs/specs/oncall-routing.md T7, R3, R13.
 *
 * Read (GET) allows agent + admin (needed for ticket-form team pickers).
 * Write (POST/PATCH/DELETE) is admin-only.
 */

import { Hono } from "hono";
import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { AuthContext } from "@platform/auth";
import { requireAuth, requireRole } from "@platform/auth";
import { db, withTenantContext, teams } from "@platform/db";
import { logger } from "@platform/logger";

type Vars = { Variables: { auth: AuthContext } };

const router = new Hono<Vars>();

router.use("*", requireAuth(db));

const TeamIdParamSchema = z.object({ id: z.string().uuid() });

const ListTeamsQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const CreateTeamSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
});

const UpdateTeamSchema = CreateTeamSchema.partial();

// GET /admin/teams
router.get(
  "/",
  requireRole("agent", "admin"),
  zValidator("query", ListTeamsQuerySchema),
  async (c) => {
    const auth = c.get("auth");
    const { cursor, limit } = c.req.valid("query");

    try {
      const result = await withTenantContext(auth.tenantId, async (tx) => {
        const conditions = [
          eq(teams.tenantId, auth.tenantId),
          isNull(teams.deletedAt),
        ];
        if (cursor) {
          const [cursorRow] = await tx
            .select({ createdAt: teams.createdAt })
            .from(teams)
            .where(and(eq(teams.id, cursor), eq(teams.tenantId, auth.tenantId)))
            .limit(1);
          if (cursorRow) {
            // Strictly-after cursor's createdAt, consistent with ORDER BY createdAt ASC.
            conditions.push(gt(teams.createdAt, cursorRow.createdAt));
          }
        }
        const rows = await tx
          .select()
          .from(teams)
          .where(and(...conditions))
          .orderBy(teams.createdAt)
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
      logger.error({ err, tenantId: auth.tenantId }, "listTeams failed");
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// POST /admin/teams
router.post(
  "/",
  requireRole("admin"),
  zValidator("json", CreateTeamSchema),
  async (c) => {
    const auth = c.get("auth");
    const input = c.req.valid("json");

    try {
      const [row] = await withTenantContext(auth.tenantId, (tx) =>
        tx
          .insert(teams)
          .values({
            tenantId: auth.tenantId,
            name: input.name,
            description: input.description,
            createdBy: auth.userId,
          })
          .returning(),
      );
      return c.json({ data: row }, 201);
    } catch (err: unknown) {
      // Postgres unique_violation on teams_tenant_name_unique (R3: duplicate
      // name within a tenant returns 409).
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
            message: "A team with this name already exists",
          },
          409,
        );
      }
      logger.error({ err, tenantId: auth.tenantId }, "createTeam failed");
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// PATCH /admin/teams/:id
router.patch(
  "/:id",
  requireRole("admin"),
  zValidator("param", TeamIdParamSchema),
  zValidator("json", UpdateTeamSchema),
  async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");

    try {
      const [row] = await withTenantContext(auth.tenantId, (tx) =>
        tx
          .update(teams)
          .set({ ...input, updatedAt: new Date() })
          .where(
            and(
              eq(teams.id, id),
              eq(teams.tenantId, auth.tenantId),
              isNull(teams.deletedAt),
            ),
          )
          .returning(),
      );

      if (!row) {
        return c.json({ error: "NOT_FOUND", message: "Team not found" }, 404);
      }
      return c.json({ data: row });
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
            message: "A team with this name already exists",
          },
          409,
        );
      }
      logger.error(
        { err, tenantId: auth.tenantId, teamId: id },
        "updateTeam failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// DELETE /admin/teams/:id — soft-delete (R3: preserves FK integrity on
// existing schedules/tickets referencing this team).
router.delete(
  "/:id",
  requireRole("admin"),
  zValidator("param", TeamIdParamSchema),
  async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");

    try {
      const [row] = await withTenantContext(auth.tenantId, (tx) =>
        tx
          .update(teams)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(teams.id, id),
              eq(teams.tenantId, auth.tenantId),
              isNull(teams.deletedAt),
            ),
          )
          .returning({ id: teams.id }),
      );

      if (!row) {
        return c.json({ error: "NOT_FOUND", message: "Team not found" }, 404);
      }
      return c.body(null, 204);
    } catch (err: unknown) {
      logger.error(
        { err, tenantId: auth.tenantId, teamId: id },
        "deleteTeam failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

export { router as teamsRouter };
