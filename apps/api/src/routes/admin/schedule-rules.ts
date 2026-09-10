/**
 * Admin Schedule Rules CRUD + executions + next-fires dry-run —
 * docs/specs/temporal-scheduler.md T4-T8, R1, R4-R6, docs/temporal-
 * scheduler-design.md §2.1-2.3.
 *
 * All routes admin-only (§C: "admin role required for all schedule rule
 * writes" -- this repo also keeps reads admin-only here, unlike labels,
 * since schedule rules are an authoring surface with no agent-facing
 * consumer today; revisit if an agent-facing "upcoming scheduled tickets"
 * view is ever built).
 *
 * template.fields is intentionally NOT deep-validated against the entity
 * type's field schema at write time here -- that logic lives inside
 * @platform/entity-engine's createEntity (no public standalone
 * validateFields export), and the design doc's own "validated... at rule
 * creation AND at fire time" language treats fire-time validation (Phase 3
 * worker calling createEntity for real) as the authoritative check. Write
 * time here validates the template's structural shape (TemplateSchema) and
 * its cross-tenant refs (team_id/service_id/assignee_id/workflow_id/
 * entity_type_id) only.
 */

import { Hono } from "hono";
import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { and, eq, gt, lt, or, isNull, desc } from "drizzle-orm";
import type { AuthContext } from "@platform/auth";
import { requireAuth, requireRole } from "@platform/auth";
import {
  db,
  withTenantContext,
  scheduleRules,
  scheduleExecutions,
  entityInstances,
} from "@platform/db";
import { writeAuditEntry } from "@platform/audit";
import {
  validateCronExpr,
  computeNextFireAt,
  getNextFires,
  describeCronExpr,
  isValidTimezone,
  TemplateSchema,
  validateScheduleRuleRefs,
  InvalidCronExpressionError,
} from "@platform/scheduler";
import { logger } from "@platform/logger";

type Vars = { Variables: { auth: AuthContext } };

const router = new Hono<Vars>();

router.use("*", requireAuth(db));

const RuleIdParamSchema = z.object({ id: z.string().uuid() });

const ListRulesQuerySchema = z.object({
  status: z.enum(["active", "paused", "archived"]).optional(),
  includeDeleted: z.coerce.boolean().default(false),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const CreateRuleSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  cronExpr: z.string().min(1),
  timezone: z.string().min(1).default("UTC"),
  entityTypeId: z.string().uuid(),
  workflowId: z.string().uuid().optional(),
  catchUp: z.boolean().default(false),
  template: TemplateSchema,
});

const UpdateRuleSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  cronExpr: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
  workflowId: z.string().uuid().optional(),
  catchUp: z.boolean().optional(),
  template: TemplateSchema.optional(),
  status: z.enum(["active", "paused", "archived"]).optional(),
});

const ExecutionsQuerySchema = z.object({
  status: z.enum(["success", "failed", "skipped"]).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const NextFiresQuerySchema = z.object({
  count: z.coerce.number().int().min(1).max(20).default(5),
});

function nullToUndefined<T>(value: T | null): T | undefined {
  // `??` can't replace this: `value ?? undefined` is flagged as a
  // needless no-op by the linter's generic-type inference (T could be
  // `null` itself, so it can't prove `value` is nullable at all) even
  // though the runtime behavior differs (null !== undefined downstream
  // for exactOptionalPropertyTypes callers). The explicit check is correct.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  return value === null ? undefined : value;
}

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

function serializeRule(
  row: typeof scheduleRules.$inferSelect,
): typeof scheduleRules.$inferSelect & { cronHuman: string | null } {
  return { ...row, cronHuman: describeCronExpr(row.cronExpr) };
}

// GET /admin/schedule-rules
router.get(
  "/",
  requireRole("admin"),
  zValidator("query", ListRulesQuerySchema),
  async (c) => {
    const auth = c.get("auth");
    const { status, includeDeleted, cursor, limit } = c.req.valid("query");

    try {
      const result = await withTenantContext(auth.tenantId, async (tx) => {
        const conditions = [eq(scheduleRules.tenantId, auth.tenantId)];
        if (!includeDeleted) conditions.push(isNull(scheduleRules.deletedAt));
        if (status) conditions.push(eq(scheduleRules.status, status));
        if (cursor) {
          const [cursorRow] = await tx
            .select({
              createdAt: scheduleRules.createdAt,
              id: scheduleRules.id,
            })
            .from(scheduleRules)
            .where(
              and(
                eq(scheduleRules.id, cursor),
                eq(scheduleRules.tenantId, auth.tenantId),
              ),
            )
            .limit(1);
          if (cursorRow) {
            const cursorCondition = or(
              gt(scheduleRules.createdAt, cursorRow.createdAt),
              and(
                eq(scheduleRules.createdAt, cursorRow.createdAt),
                gt(scheduleRules.id, cursorRow.id),
              ),
            );
            if (cursorCondition) conditions.push(cursorCondition);
          }
        }
        const rows = await tx
          .select()
          .from(scheduleRules)
          .where(and(...conditions))
          .orderBy(scheduleRules.createdAt, scheduleRules.id)
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
        data: result.entries.map(serializeRule),
        meta: {
          hasMore: result.nextCursor !== null,
          nextCursor: result.nextCursor,
        },
      });
    } catch (err: unknown) {
      logger.error(
        { err, tenantId: auth.tenantId },
        "listScheduleRules failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// GET /admin/schedule-rules/:id
router.get(
  "/:id",
  requireRole("admin"),
  zValidator("param", RuleIdParamSchema),
  async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");

    try {
      const [row] = await withTenantContext(auth.tenantId, (tx) =>
        tx
          .select()
          .from(scheduleRules)
          .where(
            and(
              eq(scheduleRules.id, id),
              eq(scheduleRules.tenantId, auth.tenantId),
              isNull(scheduleRules.deletedAt),
            ),
          )
          .limit(1),
      );

      if (!row) {
        return c.json(
          { error: "NOT_FOUND", message: "Schedule rule not found" },
          404,
        );
      }
      return c.json({ data: serializeRule(row) });
    } catch (err: unknown) {
      logger.error(
        { err, tenantId: auth.tenantId, ruleId: id },
        "getScheduleRule failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// POST /admin/schedule-rules
router.post(
  "/",
  requireRole("admin"),
  zValidator("json", CreateRuleSchema),
  async (c) => {
    const auth = c.get("auth");
    const input = c.req.valid("json");

    if (!isValidTimezone(input.timezone)) {
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message: "Validation failed",
          fields: [{ field: "timezone", message: "Invalid IANA timezone" }],
        },
        422,
      );
    }

    let nextFireAt: Date;
    try {
      validateCronExpr(input.cronExpr);
      nextFireAt = computeNextFireAt(input.cronExpr, input.timezone);
    } catch (err) {
      if (err instanceof InvalidCronExpressionError) {
        return c.json(
          {
            error: "VALIDATION_ERROR",
            message: "Validation failed",
            fields: [{ field: "cronExpr", message: err.message }],
          },
          422,
        );
      }
      throw err;
    }

    try {
      const result = await withTenantContext(auth.tenantId, async (tx) => {
        const refErrors = await validateScheduleRuleRefs(tx, auth.tenantId, {
          entityTypeId: input.entityTypeId,
          workflowId: input.workflowId,
          template: input.template,
        });
        if (refErrors.length > 0) {
          return { status: "invalid" as const, refErrors };
        }

        const [row] = await tx
          .insert(scheduleRules)
          .values({
            tenantId: auth.tenantId,
            name: input.name,
            description: input.description,
            cronExpr: input.cronExpr,
            timezone: input.timezone,
            entityTypeId: input.entityTypeId,
            workflowId: input.workflowId,
            template: input.template,
            catchUp: input.catchUp,
            nextFireAt,
            createdBy: auth.userId,
          })
          .returning();
        if (row) {
          await writeAuditEntry(tx, {
            tenantId: auth.tenantId,
            actorId: auth.userId,
            actorType: "user",
            resourceType: "schedule_rule",
            resourceId: row.id,
            action: "created",
            afterSnapshot: {
              name: row.name,
              cronExpr: row.cronExpr,
              timezone: row.timezone,
              status: row.status,
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
      if (!result.row) {
        logger.error(
          { tenantId: auth.tenantId },
          "createScheduleRule returned no row",
        );
        return c.json(
          { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
          500,
        );
      }
      return c.json({ data: serializeRule(result.row) }, 201);
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        return c.json(
          {
            error: "CONFLICT",
            message: "A schedule rule with this name already exists",
          },
          409,
        );
      }
      logger.error(
        { err, tenantId: auth.tenantId },
        "createScheduleRule failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// PATCH /admin/schedule-rules/:id
router.patch(
  "/:id",
  requireRole("admin"),
  zValidator("param", RuleIdParamSchema),
  zValidator("json", UpdateRuleSchema),
  async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");

    if (input.timezone && !isValidTimezone(input.timezone)) {
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message: "Validation failed",
          fields: [{ field: "timezone", message: "Invalid IANA timezone" }],
        },
        422,
      );
    }
    if (input.cronExpr) {
      try {
        validateCronExpr(input.cronExpr);
      } catch (err) {
        if (err instanceof InvalidCronExpressionError) {
          return c.json(
            {
              error: "VALIDATION_ERROR",
              message: "Validation failed",
              fields: [{ field: "cronExpr", message: err.message }],
            },
            422,
          );
        }
        throw err;
      }
    }

    try {
      const result = await withTenantContext(auth.tenantId, async (tx) => {
        const [existing] = await tx
          .select()
          .from(scheduleRules)
          .where(
            and(
              eq(scheduleRules.id, id),
              eq(scheduleRules.tenantId, auth.tenantId),
              isNull(scheduleRules.deletedAt),
            ),
          )
          .limit(1);
        if (!existing) return { status: "not_found" as const };

        if (existing.status === "archived" && input.status !== undefined) {
          return { status: "archived_terminal" as const };
        }

        if (input.template || input.workflowId) {
          const effectiveWorkflowId =
            input.workflowId ?? nullToUndefined(existing.workflowId);
          const refErrors = await validateScheduleRuleRefs(tx, auth.tenantId, {
            entityTypeId: existing.entityTypeId,
            workflowId: effectiveWorkflowId,
            template:
              (input.template as
                | {
                    team_id?: string;
                    service_id?: string;
                    assignee_id?: string;
                  }
                | undefined) ??
              (existing.template as {
                team_id?: string;
                service_id?: string;
                assignee_id?: string;
              }),
          });
          if (refErrors.length > 0) {
            return { status: "invalid" as const, refErrors };
          }
        }

        // Recompute next_fire_at if the schedule itself changed, or as part
        // of a paused->active resume (R4).
        const cronExpr = input.cronExpr ?? existing.cronExpr;
        const timezone = input.timezone ?? existing.timezone;
        let auditAction:
          | "updated"
          | "schedule.rule_paused"
          | "schedule.rule_resumed"
          | "schedule.rule_archived" = "updated";
        let nextFireAtUpdate: Date | null | undefined;

        if (input.status === "paused") {
          nextFireAtUpdate = null;
          auditAction = "schedule.rule_paused";
        } else if (input.status === "archived") {
          nextFireAtUpdate = null;
          auditAction = "schedule.rule_archived";
        } else if (input.status === "active" && existing.status === "paused") {
          nextFireAtUpdate = computeNextFireAt(cronExpr, timezone);
          auditAction = "schedule.rule_resumed";
        } else if (input.cronExpr || input.timezone) {
          nextFireAtUpdate = computeNextFireAt(cronExpr, timezone);
        }

        const [row] = await tx
          .update(scheduleRules)
          .set({
            ...input,
            updatedAt: new Date(),
            ...(nextFireAtUpdate !== undefined
              ? { nextFireAt: nextFireAtUpdate }
              : {}),
          })
          .where(
            and(
              eq(scheduleRules.id, id),
              eq(scheduleRules.tenantId, auth.tenantId),
            ),
          )
          .returning();
        if (row) {
          await writeAuditEntry(tx, {
            tenantId: auth.tenantId,
            actorId: auth.userId,
            actorType: "user",
            resourceType: "schedule_rule",
            resourceId: row.id,
            action: auditAction,
            beforeSnapshot: { status: existing.status },
            afterSnapshot: { status: row.status },
          });
        }
        return { status: "updated" as const, row };
      });

      if (result.status === "not_found") {
        return c.json(
          { error: "NOT_FOUND", message: "Schedule rule not found" },
          404,
        );
      }
      if (result.status === "archived_terminal") {
        return c.json(
          {
            error: "CONFLICT",
            message: "An archived schedule rule cannot change status",
          },
          409,
        );
      }
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
      if (!result.row) {
        return c.json(
          { error: "NOT_FOUND", message: "Schedule rule not found" },
          404,
        );
      }
      return c.json({ data: serializeRule(result.row) });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        return c.json(
          {
            error: "CONFLICT",
            message: "A schedule rule with this name already exists",
          },
          409,
        );
      }
      logger.error(
        { err, tenantId: auth.tenantId, ruleId: id },
        "updateScheduleRule failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// DELETE /admin/schedule-rules/:id — pauses first (next_fire_at = null,
// status = 'paused'), then soft-deletes (design doc §2.1).
router.delete(
  "/:id",
  requireRole("admin"),
  zValidator("param", RuleIdParamSchema),
  async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");

    try {
      const [row] = await withTenantContext(auth.tenantId, async (tx) => {
        const [deleted] = await tx
          .update(scheduleRules)
          .set({
            status: "paused",
            nextFireAt: null,
            deletedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(scheduleRules.id, id),
              eq(scheduleRules.tenantId, auth.tenantId),
              isNull(scheduleRules.deletedAt),
            ),
          )
          .returning({ id: scheduleRules.id, name: scheduleRules.name });
        if (deleted) {
          await writeAuditEntry(tx, {
            tenantId: auth.tenantId,
            actorId: auth.userId,
            actorType: "user",
            resourceType: "schedule_rule",
            resourceId: deleted.id,
            action: "deleted",
            beforeSnapshot: { name: deleted.name },
          });
        }
        return [deleted] as const;
      });

      if (!row) {
        return c.json(
          { error: "NOT_FOUND", message: "Schedule rule not found" },
          404,
        );
      }
      return c.body(null, 204);
    } catch (err: unknown) {
      logger.error(
        { err, tenantId: auth.tenantId, ruleId: id },
        "deleteScheduleRule failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// GET /admin/schedule-rules/:id/executions
router.get(
  "/:id/executions",
  requireRole("admin"),
  zValidator("param", RuleIdParamSchema),
  zValidator("query", ExecutionsQuerySchema),
  async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");
    const { status, cursor, limit } = c.req.valid("query");

    try {
      const result = await withTenantContext(auth.tenantId, async (tx) => {
        const [rule] = await tx
          .select({ id: scheduleRules.id })
          .from(scheduleRules)
          .where(
            and(
              eq(scheduleRules.id, id),
              eq(scheduleRules.tenantId, auth.tenantId),
            ),
          )
          .limit(1);
        if (!rule) return { status: "not_found" as const };

        const conditions = [
          eq(scheduleExecutions.ruleId, id),
          eq(scheduleExecutions.tenantId, auth.tenantId),
        ];
        if (status) conditions.push(eq(scheduleExecutions.status, status));
        if (cursor) {
          const [cursorRow] = await tx
            .select({
              scheduledAt: scheduleExecutions.scheduledAt,
              id: scheduleExecutions.id,
            })
            .from(scheduleExecutions)
            .where(
              and(
                eq(scheduleExecutions.id, cursor),
                eq(scheduleExecutions.tenantId, auth.tenantId),
              ),
            )
            .limit(1);
          if (cursorRow) {
            // Ordered scheduled_at DESC (design doc §2.2) -- cursor moves
            // strictly BEFORE the cursor row, id as tiebreaker.
            const cursorCondition = or(
              lt(scheduleExecutions.scheduledAt, cursorRow.scheduledAt),
              and(
                eq(scheduleExecutions.scheduledAt, cursorRow.scheduledAt),
                lt(scheduleExecutions.id, cursorRow.id),
              ),
            );
            if (cursorCondition) conditions.push(cursorCondition);
          }
        }

        const rows = await tx
          .select({
            id: scheduleExecutions.id,
            scheduledAt: scheduleExecutions.scheduledAt,
            firedAt: scheduleExecutions.firedAt,
            status: scheduleExecutions.status,
            entityInstanceId: scheduleExecutions.entityInstanceId,
            errorCode: scheduleExecutions.errorCode,
            // "title" lives inside entity_instances.fields (JSONB) -- there
            // is no top-level title column.
            ticketFields: entityInstances.fields,
          })
          .from(scheduleExecutions)
          .leftJoin(
            entityInstances,
            eq(scheduleExecutions.entityInstanceId, entityInstances.id),
          )
          .where(and(...conditions))
          .orderBy(
            desc(scheduleExecutions.scheduledAt),
            desc(scheduleExecutions.id),
          )
          .limit(limit + 1);

        const hasMore = rows.length > limit;
        const entries = hasMore ? rows.slice(0, limit) : rows;
        const nextCursor =
          hasMore && entries.length > 0
            ? (entries[entries.length - 1]?.id ?? null)
            : null;
        return { status: "ok" as const, entries, nextCursor };
      });

      if (result.status === "not_found") {
        return c.json(
          { error: "NOT_FOUND", message: "Schedule rule not found" },
          404,
        );
      }

      return c.json({
        data: result.entries.map((e) => ({
          id: e.id,
          scheduledAt: e.scheduledAt,
          firedAt: e.firedAt,
          status: e.status,
          ticket: e.entityInstanceId
            ? {
                id: e.entityInstanceId,
                title:
                  e.ticketFields &&
                  typeof e.ticketFields === "object" &&
                  "title" in e.ticketFields
                    ? String((e.ticketFields as { title: unknown }).title)
                    : null,
              }
            : null,
          errorCode: e.errorCode,
        })),
        meta: {
          hasMore: result.nextCursor !== null,
          nextCursor: result.nextCursor,
        },
      });
    } catch (err: unknown) {
      logger.error(
        { err, tenantId: auth.tenantId, ruleId: id },
        "listScheduleExecutions failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// GET /admin/schedule-rules/:id/next-fires — dry-run, no DB write.
router.get(
  "/:id/next-fires",
  requireRole("admin"),
  zValidator("param", RuleIdParamSchema),
  zValidator("query", NextFiresQuerySchema),
  async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");
    const { count } = c.req.valid("query");

    try {
      const rule = await withTenantContext(auth.tenantId, (tx) =>
        tx
          .select({
            cronExpr: scheduleRules.cronExpr,
            timezone: scheduleRules.timezone,
          })
          .from(scheduleRules)
          .where(
            and(
              eq(scheduleRules.id, id),
              eq(scheduleRules.tenantId, auth.tenantId),
              isNull(scheduleRules.deletedAt),
            ),
          )
          .limit(1)
          .then((rows) => rows[0]),
      );

      if (!rule) {
        return c.json(
          { error: "NOT_FOUND", message: "Schedule rule not found" },
          404,
        );
      }

      const fires = getNextFires(rule.cronExpr, rule.timezone, count);
      return c.json({ data: { timezone: rule.timezone, fires } });
    } catch (err: unknown) {
      logger.error(
        { err, tenantId: auth.tenantId, ruleId: id },
        "getNextFires failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

export { router as scheduleRulesRouter };
