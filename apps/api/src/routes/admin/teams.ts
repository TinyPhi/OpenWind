/**
 * Admin Teams CRUD — docs/specs/oncall-routing.md T7, R3, R13.
 *
 * Read (GET) allows agent + admin (needed for ticket-form team pickers).
 * Write (POST/PATCH/DELETE) is admin-only.
 */

import { Hono } from "hono";
import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { and, eq, gt, or, isNull } from "drizzle-orm";
import type { AuthContext } from "@platform/auth";
import { requireAuth, requireRole } from "@platform/auth";
import { db, withTenantContext, teams } from "@platform/db";
import { writeAuditEntry } from "@platform/audit";
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
            .select({ createdAt: teams.createdAt, id: teams.id })
            .from(teams)
            .where(and(eq(teams.id, cursor), eq(teams.tenantId, auth.tenantId)))
            .limit(1);
          if (cursorRow) {
            // id as tiebreaker (PR #590 review, B3): createdAt alone is not
            // unique -- two rows inserted in the same millisecond share an
            // identical createdAt, and a plain `gt(createdAt, cursor)` would
            // silently skip both on a burst insert.
            const cursorCondition = or(
              gt(teams.createdAt, cursorRow.createdAt),
              and(
                eq(teams.createdAt, cursorRow.createdAt),
                gt(teams.id, cursorRow.id),
              ),
            );
            if (cursorCondition) conditions.push(cursorCondition);
          }
        }
        const rows = await tx
          .select()
          .from(teams)
          .where(and(...conditions))
          .orderBy(teams.createdAt, teams.id)
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

// GET /admin/teams/:id
router.get(
  "/:id",
  requireRole("agent", "admin"),
  zValidator("param", TeamIdParamSchema),
  async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");

    try {
      const [row] = await withTenantContext(auth.tenantId, (tx) =>
        tx
          .select()
          .from(teams)
          .where(
            and(
              eq(teams.id, id),
              eq(teams.tenantId, auth.tenantId),
              isNull(teams.deletedAt),
            ),
          )
          .limit(1),
      );

      if (!row) {
        return c.json({ error: "NOT_FOUND", message: "Team not found" }, 404);
      }
      return c.json({ data: row });
    } catch (err: unknown) {
      logger.error(
        { err, tenantId: auth.tenantId, teamId: id },
        "getTeam failed",
      );
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
      const [row] = await withTenantContext(auth.tenantId, async (tx) => {
        const [inserted] = await tx
          .insert(teams)
          .values({
            tenantId: auth.tenantId,
            name: input.name,
            description: input.description,
            createdBy: auth.userId,
          })
          .returning();
        if (inserted) {
          await writeAuditEntry(tx, {
            tenantId: auth.tenantId,
            actorId: auth.userId,
            actorType: "user",
            resourceType: "team",
            resourceId: inserted.id,
            action: "created",
            afterSnapshot: {
              name: inserted.name,
              description: inserted.description,
            },
          });
        }
        return [inserted] as const;
      });

      if (!row) {
        logger.error({ tenantId: auth.tenantId }, "createTeam returned no row");
        return c.json(
          { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
          500,
        );
      }
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
      const [row] = await withTenantContext(auth.tenantId, async (tx) => {
        const [before] = await tx
          .select()
          .from(teams)
          .where(and(eq(teams.id, id), eq(teams.tenantId, auth.tenantId)))
          .limit(1);
        const [updated] = await tx
          .update(teams)
          .set({ ...input, updatedAt: new Date() })
          .where(
            and(
              eq(teams.id, id),
              eq(teams.tenantId, auth.tenantId),
              isNull(teams.deletedAt),
            ),
          )
          .returning();
        if (updated) {
          await writeAuditEntry(tx, {
            tenantId: auth.tenantId,
            actorId: auth.userId,
            actorType: "user",
            resourceType: "team",
            resourceId: updated.id,
            action: "updated",
            beforeSnapshot: before
              ? { name: before.name, description: before.description }
              : null,
            afterSnapshot: {
              name: updated.name,
              description: updated.description,
            },
          });
        }
        return [updated] as const;
      });

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
      const [row] = await withTenantContext(auth.tenantId, async (tx) => {
        const [before] = await tx
          .select({ name: teams.name })
          .from(teams)
          .where(and(eq(teams.id, id), eq(teams.tenantId, auth.tenantId)))
          .limit(1);
        const [deleted] = await tx
          .update(teams)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(teams.id, id),
              eq(teams.tenantId, auth.tenantId),
              isNull(teams.deletedAt),
            ),
          )
          .returning({ id: teams.id });
        if (deleted) {
          await writeAuditEntry(tx, {
            tenantId: auth.tenantId,
            actorId: auth.userId,
            actorType: "user",
            resourceType: "team",
            resourceId: deleted.id,
            action: "deleted",
            beforeSnapshot: before ? { name: before.name } : null,
          });
        }
        return [deleted] as const;
      });

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
