/**
 * Admin Notification Policies CRUD + resolve dry-run —
 * docs/specs/oncall-routing.md T21-T26, R14-R15, R19-R20.
 *
 * Read (GET, including /resolve) allows agent + admin (R20's fix — agents
 * need to see what a policy would resolve to). Write (POST/PATCH/DELETE) is
 * admin-only. team_id/workflow_type_id have no DB FK — app-layer cross-tenant
 * validation via packages/teams' shared helper (R1d/T44), closing PR #586
 * review B3 / issue #592's notification_policies half. workflow_type_id
 * additionally allows a NULL-tenant (global/system) workflow, matching
 * workflows.tenant_id's nullable "system template" semantics
 * (db-conventions.md) — the standard lookupValidIdsInTable helper assumes an
 * exact tenant match, so this one column gets a bespoke lookup instead.
 */

import { Hono } from "hono";
import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { and, eq, gt, lte, or, isNull, inArray } from "drizzle-orm";
import type { AuthContext } from "@platform/auth";
import { requireAuth, requireRole } from "@platform/auth";
import {
  db,
  withTenantContext,
  notificationPolicies,
  teams,
  workflows,
  onCallSchedules,
  tenantUsers,
} from "@platform/db";
import type { DbOrTx } from "@platform/db";
import {
  validateCrossTenantRefs,
  lookupValidIdsInTable,
  type FieldError,
} from "@platform/teams";
import { writeAuditEntry } from "@platform/audit";
import { logger } from "@platform/logger";

type Vars = { Variables: { auth: AuthContext } };

const router = new Hono<Vars>();

router.use("*", requireAuth(db));

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const CHANNELS = ["email", "sms", "whatsapp", "call"] as const;

const PolicyIdParamSchema = z.object({ id: z.string().uuid() });

const ListPoliciesQuerySchema = z.object({
  teamId: z.string().uuid().optional(),
  workflowTypeId: z.string().uuid().optional(),
  severity: z.enum(SEVERITIES).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const CreatePolicySchema = z.object({
  teamId: z.string().uuid().optional(),
  workflowTypeId: z.string().uuid().optional(),
  severity: z.enum(SEVERITIES),
  channels: z.array(z.enum(CHANNELS)).min(1),
  notifyBackup: z.boolean().default(true),
  notifyEscalationManager: z.boolean().default(false),
});

const UpdatePolicySchema = CreatePolicySchema.partial();

const ResolvePolicyQuerySchema = z.object({
  severity: z.enum(SEVERITIES),
  teamId: z.string().uuid().optional(),
  workflowTypeId: z.string().uuid().optional(),
});

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

// Runs under the caller's withTenantContext tx, same RLS-defense-in-depth
// reasoning as services.ts's validateTeamRef / on-call-schedules.ts's
// validateScheduleRefs (PR #583-series review).
async function validatePolicyRefs(
  tx: DbOrTx,
  tenantId: string,
  input: { teamId?: string | undefined; workflowTypeId?: string | undefined },
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

  if (input.workflowTypeId) {
    // Bespoke lookup (not lookupValidIdsInTable): a workflow is a valid
    // reference for this tenant if it belongs to this tenant OR is a
    // NULL-tenant system template (db-conventions.md's ADR-007 note).
    const workflowLookup = async (refIds: string[]): Promise<Set<string>> => {
      const rows = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(
          and(
            inArray(workflows.id, refIds),
            or(eq(workflows.tenantId, tenantId), isNull(workflows.tenantId)),
          ),
        );
      return new Set(rows.map((r) => r.id));
    };
    const workflowErrors = await validateCrossTenantRefs(
      [{ fieldName: "workflowTypeId", refId: input.workflowTypeId }],
      workflowLookup,
    );
    errors.push(
      ...workflowErrors.map((e: FieldError) => ({
        field: e.field,
        message: e.message,
      })),
    );
  }

  return errors;
}

// GET /admin/notification-policies -- admin-only read (R19 makes write
// admin-only; unlike labels, the spec never grants agents visibility into
// policy configuration itself -- only into /resolve's dry-run output, R20).
router.get(
  "/",
  requireRole("admin"),
  zValidator("query", ListPoliciesQuerySchema),
  async (c) => {
    const auth = c.get("auth");
    const { teamId, workflowTypeId, severity, cursor, limit } =
      c.req.valid("query");

    try {
      const result = await withTenantContext(auth.tenantId, async (tx) => {
        const conditions = [
          eq(notificationPolicies.tenantId, auth.tenantId),
          isNull(notificationPolicies.deletedAt),
        ];
        if (teamId) conditions.push(eq(notificationPolicies.teamId, teamId));
        if (workflowTypeId) {
          conditions.push(
            eq(notificationPolicies.workflowTypeId, workflowTypeId),
          );
        }
        if (severity) {
          conditions.push(eq(notificationPolicies.severity, severity));
        }
        if (cursor) {
          const [cursorRow] = await tx
            .select({
              createdAt: notificationPolicies.createdAt,
              id: notificationPolicies.id,
            })
            .from(notificationPolicies)
            .where(
              and(
                eq(notificationPolicies.id, cursor),
                eq(notificationPolicies.tenantId, auth.tenantId),
              ),
            )
            .limit(1);
          if (cursorRow) {
            const cursorCondition = or(
              gt(notificationPolicies.createdAt, cursorRow.createdAt),
              and(
                eq(notificationPolicies.createdAt, cursorRow.createdAt),
                gt(notificationPolicies.id, cursorRow.id),
              ),
            );
            if (cursorCondition) conditions.push(cursorCondition);
          }
        }
        const rows = await tx
          .select()
          .from(notificationPolicies)
          .where(and(...conditions))
          .orderBy(notificationPolicies.createdAt, notificationPolicies.id)
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
        "listNotificationPolicies failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// GET /admin/notification-policies/resolve — dry-run, no side effects, no
// audit entry (R20). Must be registered before /:id to avoid "resolve"
// being captured as a uuid param (same reasoning as on-call-schedules.ts's
// /current route ordering).
router.get(
  "/resolve",
  requireRole("agent", "admin"),
  zValidator("query", ResolvePolicyQuerySchema),
  async (c) => {
    const auth = c.get("auth");
    const { severity, teamId, workflowTypeId } = c.req.valid("query");

    try {
      const result = await withTenantContext(auth.tenantId, async (tx) => {
        const teamCondition = teamId
          ? (or(
              isNull(notificationPolicies.teamId),
              eq(notificationPolicies.teamId, teamId),
            ) ?? isNull(notificationPolicies.teamId))
          : isNull(notificationPolicies.teamId);
        const workflowCondition = workflowTypeId
          ? (or(
              isNull(notificationPolicies.workflowTypeId),
              eq(notificationPolicies.workflowTypeId, workflowTypeId),
            ) ?? isNull(notificationPolicies.workflowTypeId))
          : isNull(notificationPolicies.workflowTypeId);
        const conditions = [
          eq(notificationPolicies.tenantId, auth.tenantId),
          eq(notificationPolicies.severity, severity),
          isNull(notificationPolicies.deletedAt),
          teamCondition,
          workflowCondition,
        ];

        const candidates = await tx
          .select()
          .from(notificationPolicies)
          .where(and(...conditions));

        // Specificity score: team_id present +2, workflow_type_id present
        // +1 (docs/oncall-routing-design.md §3.2's algorithm) -- the four
        // partial unique indexes guarantee at most one candidate per score.
        const scored = candidates
          .map((p) => ({
            policy: p,
            score: (p.teamId ? 2 : 0) + (p.workflowTypeId ? 1 : 0),
          }))
          .sort((a, b) => b.score - a.score);
        const best = scored[0];

        if (!best) {
          return {
            policyId: null,
            matchedAt: "hardcoded-default" as const,
            channels: ["email"] as const,
            notifyBackup: true,
            notifyEscalationManager: false,
            recipients: [] as {
              role: string;
              userId: string;
              name: string | null;
            }[],
          };
        }

        const matchedAt =
          best.policy.teamId && best.policy.workflowTypeId
            ? ("team+workflow" as const)
            : best.policy.teamId
              ? ("team" as const)
              : best.policy.workflowTypeId
                ? ("workflow" as const)
                : ("global" as const);

        // Recipients derived from the resolved team's active on-call
        // schedule -- no ticket context here (this is a dry-run keyed on
        // team/workflow, not an instance), so only backup/escalationManager
        // are resolvable (the dispatch action's "assignee" recipient
        // requires a real ticket and is out of scope for this endpoint).
        const recipients: {
          role: string;
          userId: string;
          name: string | null;
        }[] = [];
        if (teamId) {
          const now = new Date();
          const [activeSchedule] = await tx
            .select()
            .from(onCallSchedules)
            .where(
              and(
                eq(onCallSchedules.tenantId, auth.tenantId),
                eq(onCallSchedules.teamId, teamId),
                isNull(onCallSchedules.deletedAt),
                lte(onCallSchedules.startsAt, now),
                gt(onCallSchedules.endsAt, now),
              ),
            )
            .limit(1);

          const candidateUserIds: { role: string; userId: string }[] = [];
          if (
            activeSchedule &&
            best.policy.notifyBackup &&
            activeSchedule.backupUserId
          ) {
            candidateUserIds.push({
              role: "backup",
              userId: activeSchedule.backupUserId,
            });
          }
          if (
            activeSchedule &&
            (best.policy.notifyEscalationManager || severity === "critical") &&
            activeSchedule.escalationManagerUserId
          ) {
            candidateUserIds.push({
              role: "escalationManager",
              userId: activeSchedule.escalationManagerUserId,
            });
          }
          if (candidateUserIds.length > 0) {
            const userRows = await tx
              .select({
                userId: tenantUsers.userId,
                displayName: tenantUsers.displayName,
                email: tenantUsers.email,
              })
              .from(tenantUsers)
              .where(
                and(
                  eq(tenantUsers.tenantId, auth.tenantId),
                  inArray(
                    tenantUsers.userId,
                    candidateUserIds.map((r) => r.userId),
                  ),
                ),
              );
            const displayById = new Map(
              userRows.map((u) => [u.userId, u.displayName ?? u.email ?? null]),
            );
            for (const r of candidateUserIds) {
              recipients.push({
                role: r.role,
                userId: r.userId,
                name: displayById.get(r.userId) ?? null,
              });
            }
          }
        }

        return {
          policyId: best.policy.id,
          matchedAt,
          channels: best.policy.channels,
          notifyBackup: best.policy.notifyBackup,
          notifyEscalationManager: best.policy.notifyEscalationManager,
          recipients,
        };
      });

      return c.json({ data: result });
    } catch (err: unknown) {
      logger.error(
        { err, tenantId: auth.tenantId },
        "resolveNotificationPolicy failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// GET /admin/notification-policies/:id -- admin-only read, same reasoning
// as the list route above.
router.get(
  "/:id",
  requireRole("admin"),
  zValidator("param", PolicyIdParamSchema),
  async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");

    try {
      const [row] = await withTenantContext(auth.tenantId, (tx) =>
        tx
          .select()
          .from(notificationPolicies)
          .where(
            and(
              eq(notificationPolicies.id, id),
              eq(notificationPolicies.tenantId, auth.tenantId),
              isNull(notificationPolicies.deletedAt),
            ),
          )
          .limit(1),
      );

      if (!row) {
        return c.json(
          { error: "NOT_FOUND", message: "Notification policy not found" },
          404,
        );
      }
      return c.json({ data: row });
    } catch (err: unknown) {
      logger.error(
        { err, tenantId: auth.tenantId, policyId: id },
        "getNotificationPolicy failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// POST /admin/notification-policies
router.post(
  "/",
  requireRole("admin"),
  zValidator("json", CreatePolicySchema),
  async (c) => {
    const auth = c.get("auth");
    const input = c.req.valid("json");

    try {
      const result = await withTenantContext(auth.tenantId, async (tx) => {
        const refErrors = await validatePolicyRefs(tx, auth.tenantId, input);
        if (refErrors.length > 0) {
          return { status: "invalid" as const, refErrors };
        }
        const [row] = await tx
          .insert(notificationPolicies)
          .values({
            tenantId: auth.tenantId,
            teamId: input.teamId,
            workflowTypeId: input.workflowTypeId,
            severity: input.severity,
            channels: input.channels,
            notifyBackup: input.notifyBackup,
            notifyEscalationManager: input.notifyEscalationManager,
            createdBy: auth.userId,
          })
          .returning();
        if (row) {
          await writeAuditEntry(tx, {
            tenantId: auth.tenantId,
            actorId: auth.userId,
            actorType: "user",
            resourceType: "notification_policy",
            resourceId: row.id,
            action: "created",
            afterSnapshot: {
              teamId: row.teamId,
              workflowTypeId: row.workflowTypeId,
              severity: row.severity,
              channels: row.channels,
              notifyBackup: row.notifyBackup,
              notifyEscalationManager: row.notifyEscalationManager,
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
      if (isUniqueViolation(err)) {
        return c.json(
          {
            error: "CONFLICT",
            message:
              "A policy already exists for this team/workflow-type/severity combination",
          },
          409,
        );
      }
      logger.error(
        { err, tenantId: auth.tenantId },
        "createNotificationPolicy failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// PATCH /admin/notification-policies/:id
router.patch(
  "/:id",
  requireRole("admin"),
  zValidator("param", PolicyIdParamSchema),
  zValidator("json", UpdatePolicySchema),
  async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");

    try {
      const result = await withTenantContext(auth.tenantId, async (tx) => {
        const refErrors = await validatePolicyRefs(tx, auth.tenantId, input);
        if (refErrors.length > 0) {
          return { status: "invalid" as const, refErrors };
        }
        const [before] = await tx
          .select()
          .from(notificationPolicies)
          .where(
            and(
              eq(notificationPolicies.id, id),
              eq(notificationPolicies.tenantId, auth.tenantId),
            ),
          )
          .limit(1);
        const [row] = await tx
          .update(notificationPolicies)
          .set({ ...input, updatedAt: new Date() })
          .where(
            and(
              eq(notificationPolicies.id, id),
              eq(notificationPolicies.tenantId, auth.tenantId),
              isNull(notificationPolicies.deletedAt),
            ),
          )
          .returning();
        if (row) {
          await writeAuditEntry(tx, {
            tenantId: auth.tenantId,
            actorId: auth.userId,
            actorType: "user",
            resourceType: "notification_policy",
            resourceId: row.id,
            action: "updated",
            beforeSnapshot: before
              ? {
                  teamId: before.teamId,
                  workflowTypeId: before.workflowTypeId,
                  severity: before.severity,
                  channels: before.channels,
                  notifyBackup: before.notifyBackup,
                  notifyEscalationManager: before.notifyEscalationManager,
                }
              : null,
            afterSnapshot: {
              teamId: row.teamId,
              workflowTypeId: row.workflowTypeId,
              severity: row.severity,
              channels: row.channels,
              notifyBackup: row.notifyBackup,
              notifyEscalationManager: row.notifyEscalationManager,
            },
          });
        }
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
          { error: "NOT_FOUND", message: "Notification policy not found" },
          404,
        );
      }
      return c.json({ data: result.row });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        return c.json(
          {
            error: "CONFLICT",
            message:
              "A policy already exists for this team/workflow-type/severity combination",
          },
          409,
        );
      }
      logger.error(
        { err, tenantId: auth.tenantId, policyId: id },
        "updateNotificationPolicy failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// DELETE /admin/notification-policies/:id — soft-delete (frees the
// specificity slot for a replacement, per the partial unique indexes).
router.delete(
  "/:id",
  requireRole("admin"),
  zValidator("param", PolicyIdParamSchema),
  async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");

    try {
      const [row] = await withTenantContext(auth.tenantId, async (tx) => {
        const [before] = await tx
          .select()
          .from(notificationPolicies)
          .where(
            and(
              eq(notificationPolicies.id, id),
              eq(notificationPolicies.tenantId, auth.tenantId),
            ),
          )
          .limit(1);
        const [deleted] = await tx
          .update(notificationPolicies)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(notificationPolicies.id, id),
              eq(notificationPolicies.tenantId, auth.tenantId),
              isNull(notificationPolicies.deletedAt),
            ),
          )
          .returning({ id: notificationPolicies.id });
        if (deleted) {
          await writeAuditEntry(tx, {
            tenantId: auth.tenantId,
            actorId: auth.userId,
            actorType: "user",
            resourceType: "notification_policy",
            resourceId: deleted.id,
            action: "deleted",
            beforeSnapshot: before
              ? {
                  teamId: before.teamId,
                  workflowTypeId: before.workflowTypeId,
                  severity: before.severity,
                }
              : null,
          });
        }
        return [deleted] as const;
      });

      if (!row) {
        return c.json(
          { error: "NOT_FOUND", message: "Notification policy not found" },
          404,
        );
      }
      return c.body(null, 204);
    } catch (err: unknown) {
      logger.error(
        { err, tenantId: auth.tenantId, policyId: id },
        "deleteNotificationPolicy failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

export { router as notificationPoliciesRouter };
