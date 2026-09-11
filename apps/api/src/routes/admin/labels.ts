/**
 * Admin Labels CRUD — docs/specs/oncall-routing.md T37, R1b, R12.
 *
 * Read (GET) allows agent + admin. Write (POST/PATCH/DELETE) is admin-only.
 * GitHub-style tenant-managed label vocabulary (ADR-016 Decision 3).
 */

import { Hono } from "hono";
import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { and, eq, gt, or, isNull } from "drizzle-orm";
import type { AuthContext } from "@platform/auth";
import { requireAuth, requireRole } from "@platform/auth";
import { db, withTenantContext, labels } from "@platform/db";
import { writeAuditEntry } from "@platform/audit";
import { logger } from "@platform/logger";

type Vars = { Variables: { auth: AuthContext } };

const router = new Hono<Vars>();

router.use("*", requireAuth(db));

const LabelIdParamSchema = z.object({ id: z.string().uuid() });

const ListLabelsQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const CreateLabelSchema = z.object({
  name: z.string().trim().min(1).max(100),
  color: z.string().regex(HEX_COLOR, "color must be a 6-digit hex code"),
  description: z.string().trim().max(2000).optional(),
});

const UpdateLabelSchema = CreateLabelSchema.partial();

// GET /admin/labels
router.get(
  "/",
  requireRole("agent", "admin"),
  zValidator("query", ListLabelsQuerySchema),
  async (c) => {
    const auth = c.get("auth");
    const { cursor, limit } = c.req.valid("query");

    try {
      const result = await withTenantContext(auth.tenantId, async (tx) => {
        const conditions = [
          eq(labels.tenantId, auth.tenantId),
          isNull(labels.deletedAt),
        ];
        if (cursor) {
          const [cursorRow] = await tx
            .select({ createdAt: labels.createdAt, id: labels.id })
            .from(labels)
            .where(
              and(eq(labels.id, cursor), eq(labels.tenantId, auth.tenantId)),
            )
            .limit(1);
          if (cursorRow) {
            // id as tiebreaker (same reasoning as teams.ts's GET / -- PR
            // #590 review, B3): createdAt alone is not unique.
            const cursorCondition = or(
              gt(labels.createdAt, cursorRow.createdAt),
              and(
                eq(labels.createdAt, cursorRow.createdAt),
                gt(labels.id, cursorRow.id),
              ),
            );
            if (cursorCondition) conditions.push(cursorCondition);
          }
        }
        const rows = await tx
          .select()
          .from(labels)
          .where(and(...conditions))
          .orderBy(labels.createdAt, labels.id)
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
      logger.error({ err, tenantId: auth.tenantId }, "listLabels failed");
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// GET /admin/labels/:id
router.get(
  "/:id",
  requireRole("agent", "admin"),
  zValidator("param", LabelIdParamSchema),
  async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");

    try {
      const [row] = await withTenantContext(auth.tenantId, (tx) =>
        tx
          .select()
          .from(labels)
          .where(
            and(
              eq(labels.id, id),
              eq(labels.tenantId, auth.tenantId),
              isNull(labels.deletedAt),
            ),
          )
          .limit(1),
      );

      if (!row) {
        return c.json({ error: "NOT_FOUND", message: "Label not found" }, 404);
      }
      return c.json({ data: row });
    } catch (err: unknown) {
      logger.error(
        { err, tenantId: auth.tenantId, labelId: id },
        "getLabel failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

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

// POST /admin/labels
router.post(
  "/",
  requireRole("admin"),
  zValidator("json", CreateLabelSchema),
  async (c) => {
    const auth = c.get("auth");
    const input = c.req.valid("json");

    try {
      const [row] = await withTenantContext(auth.tenantId, async (tx) => {
        const [inserted] = await tx
          .insert(labels)
          .values({
            tenantId: auth.tenantId,
            name: input.name,
            color: input.color,
            description: input.description,
            createdBy: auth.userId,
          })
          .returning();
        if (inserted) {
          await writeAuditEntry(tx, {
            tenantId: auth.tenantId,
            actorId: auth.userId,
            actorType: "user",
            resourceType: "label",
            resourceId: inserted.id,
            action: "created",
            afterSnapshot: {
              name: inserted.name,
              color: inserted.color,
              description: inserted.description,
            },
          });
        }
        return [inserted] as const;
      });

      if (!row) {
        logger.error(
          { tenantId: auth.tenantId },
          "createLabel returned no row",
        );
        return c.json(
          { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
          500,
        );
      }
      return c.json({ data: row }, 201);
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        return c.json(
          {
            error: "CONFLICT",
            message: "A label with this name already exists",
          },
          409,
        );
      }
      logger.error({ err, tenantId: auth.tenantId }, "createLabel failed");
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// PATCH /admin/labels/:id
router.patch(
  "/:id",
  requireRole("admin"),
  zValidator("param", LabelIdParamSchema),
  zValidator("json", UpdateLabelSchema),
  async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");

    try {
      const [row] = await withTenantContext(auth.tenantId, async (tx) => {
        const [before] = await tx
          .select()
          .from(labels)
          .where(
            and(
              eq(labels.id, id),
              eq(labels.tenantId, auth.tenantId),
              isNull(labels.deletedAt),
            ),
          )
          .limit(1);
        const [updated] = await tx
          .update(labels)
          .set({ ...input, updatedAt: new Date() })
          .where(
            and(
              eq(labels.id, id),
              eq(labels.tenantId, auth.tenantId),
              isNull(labels.deletedAt),
            ),
          )
          .returning();
        if (updated) {
          await writeAuditEntry(tx, {
            tenantId: auth.tenantId,
            actorId: auth.userId,
            actorType: "user",
            resourceType: "label",
            resourceId: updated.id,
            action: "updated",
            beforeSnapshot: before
              ? {
                  name: before.name,
                  color: before.color,
                  description: before.description,
                }
              : null,
            afterSnapshot: {
              name: updated.name,
              color: updated.color,
              description: updated.description,
            },
          });
        }
        return [updated] as const;
      });

      if (!row) {
        return c.json({ error: "NOT_FOUND", message: "Label not found" }, 404);
      }
      return c.json({ data: row });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        return c.json(
          {
            error: "CONFLICT",
            message: "A label with this name already exists",
          },
          409,
        );
      }
      logger.error(
        { err, tenantId: auth.tenantId, labelId: id },
        "updateLabel failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// DELETE /admin/labels/:id — soft-delete (frees the name for reuse via the
// partial unique index, migration 0096).
router.delete(
  "/:id",
  requireRole("admin"),
  zValidator("param", LabelIdParamSchema),
  async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");

    try {
      const [row] = await withTenantContext(auth.tenantId, async (tx) => {
        const [before] = await tx
          .select({ name: labels.name })
          .from(labels)
          .where(
            and(
              eq(labels.id, id),
              eq(labels.tenantId, auth.tenantId),
              isNull(labels.deletedAt),
            ),
          )
          .limit(1);
        const [deleted] = await tx
          .update(labels)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(labels.id, id),
              eq(labels.tenantId, auth.tenantId),
              isNull(labels.deletedAt),
            ),
          )
          .returning({ id: labels.id });
        if (deleted) {
          await writeAuditEntry(tx, {
            tenantId: auth.tenantId,
            actorId: auth.userId,
            actorType: "user",
            resourceType: "label",
            resourceId: deleted.id,
            action: "deleted",
            beforeSnapshot: before ? { name: before.name } : null,
          });
        }
        return [deleted] as const;
      });

      if (!row) {
        return c.json({ error: "NOT_FOUND", message: "Label not found" }, 404);
      }
      return c.body(null, 204);
    } catch (err: unknown) {
      logger.error(
        { err, tenantId: auth.tenantId, labelId: id },
        "deleteLabel failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

export { router as labelsRouter };
