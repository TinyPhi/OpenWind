/**
 * Admin On-Call Schedules CRUD + snapshot — docs/specs/oncall-routing.md
 * T9, T10, R5-R7.
 *
 * Read (GET) allows agent + admin. Write (POST/PATCH/DELETE) is admin-only.
 * team_id/primary_user_id/backup_user_id/escalation_manager_user_id have no
 * DB FK -- app-layer cross-tenant validation via packages/teams' shared
 * helper (R1d/T44). team_id is validated against `teams`; user ids are
 * validated by resolving against the `tenant_users` shadow table, same
 * approach as packages/entity-engine's validateUserRefs (a user id with no
 * tenant_users row is treated as non-existent at the application layer --
 * this schema has no separate "deactivated user" signal beyond that, so
 * R6's "referenced_user_deleted" distinction is approximated as "no
 * tenant_users row found", not a true deactivation flag).
 */

import { Hono } from "hono";
import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { and, eq, gt, or, inArray, isNull, lte, gte, asc } from "drizzle-orm";
import type { AuthContext } from "@platform/auth";
import { requireAuth, requireRole } from "@platform/auth";
import {
  db,
  withTenantContext,
  onCallSchedules,
  teams,
  tenantUsers,
} from "@platform/db";
import type { DbOrTx } from "@platform/db";
import {
  validateCrossTenantRefs,
  lookupValidIdsInTable,
  type FieldError,
  type CrossTenantRefCheck,
} from "@platform/teams";
import { writeAuditEntry } from "@platform/audit";
import { logger } from "@platform/logger";

type Vars = { Variables: { auth: AuthContext } };

const router = new Hono<Vars>();

router.use("*", requireAuth(db));

const ScheduleIdParamSchema = z.object({ id: z.string().uuid() });

const ListSchedulesQuerySchema = z.object({
  teamId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const CreateScheduleSchema = z
  .object({
    teamId: z.string().uuid(),
    label: z.string().trim().min(1).max(200),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    primaryUserId: z.string().min(1),
    backupUserId: z.string().min(1).optional(),
    escalationManagerUserId: z.string().min(1).optional(),
  })
  .refine((v) => v.startsAt < v.endsAt, {
    message: "startsAt must be before endsAt",
    path: ["endsAt"],
  });

const UpdateScheduleSchema = z
  .object({
    label: z.string().trim().min(1).max(200).optional(),
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().optional(),
    primaryUserId: z.string().min(1).optional(),
    backupUserId: z.string().min(1).optional(),
    escalationManagerUserId: z.string().min(1).optional(),
  })
  .refine((v) => !(v.startsAt && v.endsAt) || v.startsAt < v.endsAt, {
    message: "startsAt must be before endsAt",
    path: ["endsAt"],
  });

function isExclusionViolation(err: unknown): boolean {
  return Boolean(
    err &&
    typeof err === "object" &&
    "cause" in err &&
    err.cause &&
    typeof err.cause === "object" &&
    "code" in err.cause &&
    err.cause.code === "23P01",
  );
}

// Runs under the caller's withTenantContext tx (not the raw db client) so
// these lookups are defended by RLS as a second layer, not just the
// explicit tenantId filters already applied (PR #583-series review: an
// app-layer-only check with no RLS backstop is one accidental edit away
// from a cross-tenant leak).
async function validateScheduleRefs(
  tx: DbOrTx,
  tenantId: string,
  input: {
    teamId?: string | undefined;
    primaryUserId?: string | undefined;
    backupUserId?: string | undefined;
    escalationManagerUserId?: string | undefined;
  },
): Promise<{ field: string; message: string }[]> {
  const errors: { field: string; message: string }[] = [];

  if (input.teamId) {
    const lookup = lookupValidIdsInTable(
      tx,
      teams,
      teams.id,
      teams.tenantId,
      teams.deletedAt,
      tenantId,
    );
    const teamErrors = await validateCrossTenantRefs(
      [{ fieldName: "teamId", refId: input.teamId }],
      lookup,
    );
    errors.push(
      ...teamErrors.map((e: FieldError) => ({
        field: e.field,
        message: e.message,
      })),
    );
  }

  const userRefs: CrossTenantRefCheck[] = [];
  if (input.primaryUserId) {
    userRefs.push({ fieldName: "primaryUserId", refId: input.primaryUserId });
  }
  if (input.backupUserId) {
    userRefs.push({ fieldName: "backupUserId", refId: input.backupUserId });
  }
  if (input.escalationManagerUserId) {
    userRefs.push({
      fieldName: "escalationManagerUserId",
      refId: input.escalationManagerUserId,
    });
  }
  if (userRefs.length > 0) {
    // Scoped to the 1-3 specific user ids being validated, not a full
    // tenant_users table scan (PR #590 review, B4).
    const userLookup = lookupValidIdsInTable(
      tx,
      tenantUsers,
      tenantUsers.userId,
      tenantUsers.tenantId,
      undefined, // tenant_users has no soft-delete column
      tenantId,
    );
    const userErrors = await validateCrossTenantRefs(userRefs, userLookup);
    errors.push(
      ...userErrors.map((e: FieldError) => ({
        field: e.field,
        message: e.message,
      })),
    );
  }

  return errors;
}

// GET /admin/on-call-schedules
router.get(
  "/",
  requireRole("agent", "admin"),
  zValidator("query", ListSchedulesQuerySchema),
  async (c) => {
    const auth = c.get("auth");
    const { teamId, from, to, cursor, limit } = c.req.valid("query");

    try {
      const result = await withTenantContext(auth.tenantId, async (tx) => {
        const conditions = [
          eq(onCallSchedules.tenantId, auth.tenantId),
          isNull(onCallSchedules.deletedAt),
        ];
        if (teamId) conditions.push(eq(onCallSchedules.teamId, teamId));
        if (from) conditions.push(gte(onCallSchedules.startsAt, from));
        if (to) conditions.push(lte(onCallSchedules.endsAt, to));
        if (cursor) {
          const [cursorRow] = await tx
            .select({
              startsAt: onCallSchedules.startsAt,
              id: onCallSchedules.id,
            })
            .from(onCallSchedules)
            .where(
              and(
                eq(onCallSchedules.id, cursor),
                eq(onCallSchedules.tenantId, auth.tenantId),
              ),
            )
            .limit(1);
          if (cursorRow) {
            // id as tiebreaker (PR #590 review, B3) -- two schedules for
            // different teams can share an identical startsAt.
            const cursorCondition = or(
              gt(onCallSchedules.startsAt, cursorRow.startsAt),
              and(
                eq(onCallSchedules.startsAt, cursorRow.startsAt),
                gt(onCallSchedules.id, cursorRow.id),
              ),
            );
            if (cursorCondition) conditions.push(cursorCondition);
          }
        }
        const rows = await tx
          .select()
          .from(onCallSchedules)
          .where(and(...conditions))
          .orderBy(asc(onCallSchedules.startsAt), asc(onCallSchedules.id))
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
      logger.error(
        { err, tenantId: auth.tenantId },
        "listOnCallSchedules failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// GET /admin/on-call-schedules/current — active on-call snapshot per team
// (R6). LEFT JOIN so a team with no active schedule still appears with
// oncall: null (not omitted). Soft-deleted teams are excluded entirely.
router.get("/current", requireRole("agent", "admin"), async (c) => {
  const auth = c.get("auth");

  try {
    const now = new Date();
    const rows = await withTenantContext(auth.tenantId, async (tx) => {
      const teamRows = await tx
        .select({ id: teams.id, name: teams.name })
        .from(teams)
        .where(and(eq(teams.tenantId, auth.tenantId), isNull(teams.deletedAt)));

      const activeSchedules = await tx
        .select()
        .from(onCallSchedules)
        .where(
          and(
            eq(onCallSchedules.tenantId, auth.tenantId),
            isNull(onCallSchedules.deletedAt),
            lte(onCallSchedules.startsAt, now),
            gt(onCallSchedules.endsAt, now),
          ),
        );
      const scheduleByTeam = new Map(activeSchedules.map((s) => [s.teamId, s]));

      const allUserIds = new Set<string>();
      for (const s of activeSchedules) {
        allUserIds.add(s.primaryUserId);
        if (s.backupUserId) allUserIds.add(s.backupUserId);
        if (s.escalationManagerUserId)
          allUserIds.add(s.escalationManagerUserId);
      }
      // Scoped to the handful of user ids referenced by active schedules,
      // not a full tenant_users table scan (PR #590 review, G2).
      const userRows =
        allUserIds.size > 0
          ? await tx
              .select({
                userId: tenantUsers.userId,
                displayName: tenantUsers.displayName,
                email: tenantUsers.email,
              })
              .from(tenantUsers)
              .where(
                and(
                  eq(tenantUsers.tenantId, auth.tenantId),
                  inArray(tenantUsers.userId, [...allUserIds]),
                ),
              )
          : [];
      const userDisplayById = new Map(
        userRows.map((u) => [u.userId, u.displayName ?? u.email ?? u.userId]),
      );

      function resolveUser(userId: string | null): {
        userId: string;
        displayName: string | null;
        reason?: string;
      } | null {
        if (!userId) return null;
        const display = userDisplayById.get(userId);
        if (!display) {
          // No tenant_users row -- treated as an unresolvable reference,
          // the closest available signal to "deactivated" in this schema
          // (see this file's header comment).
          return {
            userId,
            displayName: null,
            reason: "referenced_user_deleted",
          };
        }
        return { userId, displayName: display };
      }

      return teamRows.map((team) => {
        const schedule = scheduleByTeam.get(team.id);
        if (!schedule) {
          return { teamId: team.id, teamName: team.name, oncall: null };
        }
        return {
          teamId: team.id,
          teamName: team.name,
          oncall: {
            scheduleId: schedule.id,
            primary: resolveUser(schedule.primaryUserId),
            backup: resolveUser(schedule.backupUserId),
            escalationManager: resolveUser(schedule.escalationManagerUserId),
          },
        };
      });
    });

    return c.json({ data: rows });
  } catch (err: unknown) {
    logger.error(
      { err, tenantId: auth.tenantId },
      "getCurrentOnCallSnapshot failed",
    );
    return c.json(
      { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
      500,
    );
  }
});

// GET /admin/on-call-schedules/:id
router.get(
  "/:id",
  requireRole("agent", "admin"),
  zValidator("param", ScheduleIdParamSchema),
  async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");

    try {
      const [row] = await withTenantContext(auth.tenantId, (tx) =>
        tx
          .select()
          .from(onCallSchedules)
          .where(
            and(
              eq(onCallSchedules.id, id),
              eq(onCallSchedules.tenantId, auth.tenantId),
              isNull(onCallSchedules.deletedAt),
            ),
          )
          .limit(1),
      );

      if (!row) {
        return c.json(
          { error: "NOT_FOUND", message: "Schedule not found" },
          404,
        );
      }
      return c.json({ data: row });
    } catch (err: unknown) {
      logger.error(
        { err, tenantId: auth.tenantId, scheduleId: id },
        "getOnCallSchedule failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// POST /admin/on-call-schedules
router.post(
  "/",
  requireRole("admin"),
  zValidator("json", CreateScheduleSchema),
  async (c) => {
    const auth = c.get("auth");
    const input = c.req.valid("json");

    try {
      const result = await withTenantContext(auth.tenantId, async (tx) => {
        const refErrors = await validateScheduleRefs(tx, auth.tenantId, input);
        if (refErrors.length > 0) {
          return { status: "invalid" as const, refErrors };
        }
        const [row] = await tx
          .insert(onCallSchedules)
          .values({
            tenantId: auth.tenantId,
            teamId: input.teamId,
            label: input.label,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            primaryUserId: input.primaryUserId,
            backupUserId: input.backupUserId,
            escalationManagerUserId: input.escalationManagerUserId,
            createdBy: auth.userId,
          })
          .returning();
        if (row) {
          await writeAuditEntry(tx, {
            tenantId: auth.tenantId,
            actorId: auth.userId,
            actorType: "user",
            resourceType: "on_call_schedule",
            resourceId: row.id,
            action: "created",
            afterSnapshot: {
              teamId: row.teamId,
              label: row.label,
              startsAt: row.startsAt,
              endsAt: row.endsAt,
              primaryUserId: row.primaryUserId,
              backupUserId: row.backupUserId,
              escalationManagerUserId: row.escalationManagerUserId,
            },
          });
        }
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
      // GIST exclusion constraint violation (R5: overlapping window for the
      // same team + tenant).
      if (isExclusionViolation(err)) {
        return c.json(
          {
            error: "CONFLICT",
            message: "This window overlaps an existing schedule for this team",
          },
          409,
        );
      }
      logger.error(
        { err, tenantId: auth.tenantId },
        "createOnCallSchedule failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// PATCH /admin/on-call-schedules/:id — only permitted if starts_at > now()
// (R5: editing an already-started or past window returns 422).
router.patch(
  "/:id",
  requireRole("admin"),
  zValidator("param", ScheduleIdParamSchema),
  zValidator("json", UpdateScheduleSchema),
  async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");

    try {
      const result = await withTenantContext(auth.tenantId, async (tx) => {
        const refErrors = await validateScheduleRefs(tx, auth.tenantId, input);
        if (refErrors.length > 0) {
          return { status: "invalid" as const, refErrors };
        }
        const [existing] = await tx
          .select()
          .from(onCallSchedules)
          .where(
            and(
              eq(onCallSchedules.id, id),
              eq(onCallSchedules.tenantId, auth.tenantId),
              isNull(onCallSchedules.deletedAt),
            ),
          )
          .limit(1);

        if (!existing) return { status: "not_found" as const };
        if (existing.startsAt <= new Date()) {
          return { status: "already_started" as const };
        }

        const [row] = await tx
          .update(onCallSchedules)
          .set({ ...input, updatedAt: new Date() })
          .where(eq(onCallSchedules.id, id))
          .returning();
        if (row) {
          await writeAuditEntry(tx, {
            tenantId: auth.tenantId,
            actorId: auth.userId,
            actorType: "user",
            resourceType: "on_call_schedule",
            resourceId: row.id,
            action: "updated",
            beforeSnapshot: {
              label: existing.label,
              startsAt: existing.startsAt,
              endsAt: existing.endsAt,
              primaryUserId: existing.primaryUserId,
              backupUserId: existing.backupUserId,
              escalationManagerUserId: existing.escalationManagerUserId,
            },
            afterSnapshot: {
              label: row.label,
              startsAt: row.startsAt,
              endsAt: row.endsAt,
              primaryUserId: row.primaryUserId,
              backupUserId: row.backupUserId,
              escalationManagerUserId: row.escalationManagerUserId,
            },
          });
        }
        return { status: "updated" as const, row };
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
          { error: "NOT_FOUND", message: "Schedule not found" },
          404,
        );
      }
      if (result.status === "already_started") {
        return c.json(
          {
            error: "VALIDATION_ERROR",
            message: "Only future-window schedule entries can be modified",
          },
          422,
        );
      }
      return c.json({ data: result.row });
    } catch (err: unknown) {
      if (isExclusionViolation(err)) {
        return c.json(
          {
            error: "CONFLICT",
            message: "This window overlaps an existing schedule for this team",
          },
          409,
        );
      }
      logger.error(
        { err, tenantId: auth.tenantId, scheduleId: id },
        "updateOnCallSchedule failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// DELETE /admin/on-call-schedules/:id — soft-delete (preserves audit trail
// and historical on-call lookups, per spec §V).
router.delete(
  "/:id",
  requireRole("admin"),
  zValidator("param", ScheduleIdParamSchema),
  async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");

    try {
      const [row] = await withTenantContext(auth.tenantId, async (tx) => {
        const [before] = await tx
          .select()
          .from(onCallSchedules)
          .where(
            and(
              eq(onCallSchedules.id, id),
              eq(onCallSchedules.tenantId, auth.tenantId),
            ),
          )
          .limit(1);
        const [deleted] = await tx
          .update(onCallSchedules)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(onCallSchedules.id, id),
              eq(onCallSchedules.tenantId, auth.tenantId),
              isNull(onCallSchedules.deletedAt),
            ),
          )
          .returning({ id: onCallSchedules.id });
        if (deleted) {
          await writeAuditEntry(tx, {
            tenantId: auth.tenantId,
            actorId: auth.userId,
            actorType: "user",
            resourceType: "on_call_schedule",
            resourceId: deleted.id,
            action: "deleted",
            beforeSnapshot: before
              ? {
                  teamId: before.teamId,
                  label: before.label,
                  startsAt: before.startsAt,
                  endsAt: before.endsAt,
                }
              : null,
          });
        }
        return [deleted] as const;
      });

      if (!row) {
        return c.json(
          { error: "NOT_FOUND", message: "Schedule not found" },
          404,
        );
      }
      return c.body(null, 204);
    } catch (err: unknown) {
      logger.error(
        { err, tenantId: auth.tenantId, scheduleId: id },
        "deleteOnCallSchedule failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

export { router as onCallSchedulesRouter };
