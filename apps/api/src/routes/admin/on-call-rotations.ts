/**
 * Admin on-call rotations -- docs/specs/oncall-team-rotation.md R4, R9, R10.
 *
 * A rotation is created together with its first window (POST /admin/on-call-schedules
 * with `repeat`); this router lists, pauses (stops), resumes, ends and "deletes" (stops) it.
 * Pausing keeps new windows from being made and removes the windows that have not started
 * yet, so the team's time is free for another roster; the window running now stays. Only one
 * rotation per team can be active, so a paused one cannot resume once another is active.
 */

import { Hono } from "hono";
import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { AuthContext } from "@platform/auth";
import { requireAuth, requireRole } from "@platform/auth";
import type { DbOrTx } from "@platform/db";
import { db, withTenantContext, onCallRotations, teams } from "@platform/db";
import {
  loadPreviousHolders,
  loadTeamMemberIds,
  nextAssignment,
  projectWindows,
} from "@platform/teams";
import { writeAuditEntry } from "@platform/audit";
import { releaseUpcomingWindows } from "../../lib/rotation-windows.js";
import { logger } from "@platform/logger";

type Vars = { Variables: { auth: AuthContext } };

const router = new Hono<Vars>();

router.use("*", requireAuth(db));

const RotationIdParamSchema = z.object({ id: z.string().uuid() });

const ListRotationsQuerySchema = z.object({
  teamId: z.string().uuid().optional(),
});

const DateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), {
    message: "Not a valid date",
  });

const UpdateRotationSchema = z
  .object({
    status: z.enum(["active", "stopped"]).optional(),
    endsOn: DateOnlySchema.nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.endsOn !== undefined, {
    message: "Provide status or endsOn",
  });

type RotationRow = typeof onCallRotations.$inferSelect;

function isUniqueViolation(err: unknown): boolean {
  return Boolean(
    err &&
    typeof err === "object" &&
    "cause" in err &&
    err.cause &&
    typeof err.cause === "object" &&
    "code" in err.cause &&
    err.cause.code === "23505",
  );
}

interface RotationView {
  id: string;
  teamId: string;
  cycleDays: number;
  status: string;
  blocked: boolean;
  blockedReason: string | null;
  endsOn: string | null;
  nextStartsAt: Date;
  nextPrimaryUserId: string | null;
  nextBackupUserId: string | null;
  escalationManagerUserId: string | null;
  /** Windows the roster will make next, for display only. Empty unless it is running unblocked. */
  projected: Array<{
    startsAt: Date;
    endsAt: Date;
    primaryUserId: string;
    backupUserId: string | null;
    escalationManagerUserId: string | null;
  }>;
  createdAt: Date;
}

const PROJECTED_WINDOWS = 12;

async function presentRotation(
  tx: DbOrTx,
  tenantId: string,
  row: RotationRow,
): Promise<RotationView> {
  const members = await loadTeamMemberIds(tx, tenantId, row.teamId);
  const previous = await loadPreviousHolders(tx, tenantId, row);
  const next = nextAssignment(members, previous);
  const projected =
    row.status === "active" && row.blockedReason === null
      ? projectWindows({
          members,
          cycleDays: row.cycleDays,
          nextStartsAt: row.nextStartsAt,
          previous,
          escalationManager: row.escalationManagerUserId,
          endsOn: row.endsOn,
          count: PROJECTED_WINDOWS,
        }).map((w) => ({
          startsAt: w.startsAt,
          endsAt: w.endsAt,
          primaryUserId: w.primary,
          backupUserId: w.backup,
          escalationManagerUserId: w.escalationManager,
        }))
      : [];
  return {
    id: row.id,
    teamId: row.teamId,
    cycleDays: row.cycleDays,
    status: row.status,
    blocked: row.status === "active" && row.blockedReason !== null,
    blockedReason: row.blockedReason,
    endsOn: row.endsOn,
    nextStartsAt: row.nextStartsAt,
    nextPrimaryUserId: next?.primary ?? null,
    nextBackupUserId: next?.backup ?? null,
    escalationManagerUserId: row.escalationManagerUserId,
    projected,
    createdAt: row.createdAt,
  };
}

// GET /admin/on-call-rotations?teamId
router.get(
  "/",
  requireRole("agent", "admin"),
  zValidator("query", ListRotationsQuerySchema),
  async (c) => {
    const auth = c.get("auth");
    const { teamId } = c.req.valid("query");

    try {
      const data = await withTenantContext(auth.tenantId, async (tx) => {
        const conditions = [eq(onCallRotations.tenantId, auth.tenantId)];
        if (teamId) conditions.push(eq(onCallRotations.teamId, teamId));
        const rows = await tx
          .select()
          .from(onCallRotations)
          .where(and(...conditions))
          .orderBy(desc(onCallRotations.createdAt), onCallRotations.id)
          .limit(100);
        return Promise.all(
          rows.map((r) => presentRotation(tx, auth.tenantId, r)),
        );
      });
      return c.json({ data });
    } catch (err: unknown) {
      logger.error({ err, tenantId: auth.tenantId }, "listRotations failed");
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// PATCH /admin/on-call-rotations/:id -- stop, resume, set or clear the end date
router.patch(
  "/:id",
  requireRole("admin"),
  zValidator("param", RotationIdParamSchema),
  zValidator("json", UpdateRotationSchema),
  async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");

    try {
      const result = await withTenantContext(auth.tenantId, async (tx) => {
        const [before] = await tx
          .select()
          .from(onCallRotations)
          .where(
            and(
              eq(onCallRotations.id, id),
              eq(onCallRotations.tenantId, auth.tenantId),
            ),
          )
          .limit(1)
          // the worker moves the cursor and blocked reason; lock first so `before` is not stale
          .for("update");
        if (!before) return { status: "not_found" as const };

        const resuming =
          input.status === "active" && before.status !== "active";
        if (resuming) {
          const [liveTeam] = await tx
            .select({ id: teams.id })
            .from(teams)
            .where(
              and(
                eq(teams.id, before.teamId),
                eq(teams.tenantId, auth.tenantId),
                isNull(teams.deletedAt),
              ),
            )
            .limit(1);
          if (!liveTeam) return { status: "team_deleted" as const };
          const members = await loadTeamMemberIds(
            tx,
            auth.tenantId,
            before.teamId,
          );
          if (members.length === 0) return { status: "no_members" as const };
        }

        const [row] = await tx
          .update(onCallRotations)
          .set({
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.endsOn !== undefined ? { endsOn: input.endsOn } : {}),
            // a resumed rotation is re-checked by the worker on its next pass
            ...(resuming ? { blockedReason: null } : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(onCallRotations.id, id),
              eq(onCallRotations.tenantId, auth.tenantId),
            ),
          )
          .returning();
        if (!row) return { status: "not_found" as const };

        if (input.status === "stopped" && before.status === "active") {
          await releaseUpcomingWindows(tx, auth.tenantId, auth.userId, row);
        }

        await writeAuditEntry(tx, {
          tenantId: auth.tenantId,
          actorId: auth.userId,
          actorType: "user",
          resourceType: "on_call_rotation",
          resourceId: row.id,
          action: "updated",
          beforeSnapshot: {
            status: before.status,
            endsOn: before.endsOn,
          },
          afterSnapshot: { status: row.status, endsOn: row.endsOn },
        });
        return {
          status: "updated" as const,
          data: await presentRotation(tx, auth.tenantId, row),
        };
      });

      if (result.status === "not_found") {
        return c.json(
          { error: "NOT_FOUND", message: "Rotation not found" },
          404,
        );
      }
      if (result.status === "team_deleted") {
        return c.json(
          {
            error: "VALIDATION_ERROR",
            message: "Validation failed",
            fields: [
              {
                field: "status",
                message:
                  "This team has been deleted, so its rotation cannot resume",
              },
            ],
          },
          422,
        );
      }
      if (result.status === "no_members") {
        return c.json(
          {
            error: "VALIDATION_ERROR",
            message: "Validation failed",
            fields: [
              {
                field: "status",
                message:
                  "A rotation needs a team with at least one member to resume",
              },
            ],
          },
          422,
        );
      }
      return c.json({ data: result.data });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        return c.json(
          {
            error: "CONFLICT",
            message:
              "This team already has an active repeating roster, so only one can run at a time",
          },
          409,
        );
      }
      logger.error(
        { err, tenantId: auth.tenantId, rotationId: id },
        "updateRotation failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// DELETE /admin/on-call-rotations/:id -- stops the rotation; upcoming windows are removed, the running one stays
router.delete(
  "/:id",
  requireRole("admin"),
  zValidator("param", RotationIdParamSchema),
  async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");

    try {
      const found = await withTenantContext(auth.tenantId, async (tx) => {
        const [before] = await tx
          .select()
          .from(onCallRotations)
          .where(
            and(
              eq(onCallRotations.id, id),
              eq(onCallRotations.tenantId, auth.tenantId),
            ),
          )
          .limit(1);
        if (!before) return false;
        if (before.status === "stopped") return true;
        const [stopped] = await tx
          .update(onCallRotations)
          .set({ status: "stopped", updatedAt: new Date() })
          .where(
            and(
              eq(onCallRotations.id, id),
              eq(onCallRotations.tenantId, auth.tenantId),
            ),
          )
          .returning();
        if (stopped) {
          await releaseUpcomingWindows(tx, auth.tenantId, auth.userId, stopped);
        }
        await writeAuditEntry(tx, {
          tenantId: auth.tenantId,
          actorId: auth.userId,
          actorType: "user",
          resourceType: "on_call_rotation",
          resourceId: id,
          action: "updated",
          beforeSnapshot: { status: before.status },
          afterSnapshot: { status: "stopped" },
        });
        return true;
      });

      if (!found) {
        return c.json(
          { error: "NOT_FOUND", message: "Rotation not found" },
          404,
        );
      }
      return c.body(null, 204);
    } catch (err: unknown) {
      logger.error(
        { err, tenantId: auth.tenantId, rotationId: id },
        "stopRotation failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

export { router as onCallRotationsRouter };
