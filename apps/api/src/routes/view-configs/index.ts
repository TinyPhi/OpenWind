import { Hono } from "hono";
import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { AuthContext } from "@platform/auth";
import { requireAuth, requireRole } from "@platform/auth";
import { db, withTenantContext, viewConfigs } from "@platform/db";
import { logger } from "@platform/logger";

type Vars = { Variables: { auth: AuthContext } };

const router = new Hono<Vars>();

router.use("*", requireAuth(db));

const EntityTypeParamSchema = z.object({
  entityType: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/, "Invalid entity type slug"),
});

const PatchBodySchema = z.object({
  listColumns: z.array(z.unknown()).optional(),
  detailLayout: z.array(z.unknown()).optional(),
  formFieldOrder: z.array(z.unknown()).optional(),
});

// GET /admin/view-configs/:entityType
router.get(
  "/:entityType",
  zValidator("param", EntityTypeParamSchema),
  async (c) => {
    const auth = c.get("auth");
    const { entityType } = c.req.valid("param");

    try {
      const [row] = await withTenantContext(auth.tenantId, (tx) =>
        tx
          .select()
          .from(viewConfigs)
          .where(
            and(
              eq(viewConfigs.tenantId, auth.tenantId),
              eq(viewConfigs.entityTypeSlug, entityType),
            ),
          )
          .limit(1),
      );

      if (!row) {
        return c.json(
          { error: "NOT_FOUND", message: "View config not found" },
          404,
        );
      }

      return c.json({ data: row });
    } catch (err: unknown) {
      logger.error(
        { err, tenantId: auth.tenantId, entityType },
        "getViewConfig failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// PATCH /admin/view-configs/:entityType (Admin only)
router.patch(
  "/:entityType",
  requireRole("admin"),
  zValidator("param", EntityTypeParamSchema),
  zValidator("json", PatchBodySchema),
  async (c) => {
    const auth = c.get("auth");
    const { entityType } = c.req.valid("param");
    const body = c.req.valid("json");

    try {
      const { row, isNew } = await withTenantContext(
        auth.tenantId,
        async (tx) => {
          // Fetch existing row first to merge
          const [existing] = await tx
            .select()
            .from(viewConfigs)
            .where(
              and(
                eq(viewConfigs.tenantId, auth.tenantId),
                eq(viewConfigs.entityTypeSlug, entityType),
              ),
            )
            .limit(1);

          const listColumns = (body.listColumns ??
            existing?.listColumns ??
            []) as string[];
          const detailLayout = (body.detailLayout ??
            existing?.detailLayout ??
            []) as string[];
          const formFieldOrder = (body.formFieldOrder ??
            existing?.formFieldOrder ??
            []) as string[];

          const [updated] = await tx
            .insert(viewConfigs)
            .values({
              tenantId: auth.tenantId,
              entityTypeSlug: entityType,
              listColumns,
              detailLayout,
              formFieldOrder,
            })
            .onConflictDoUpdate({
              target: [viewConfigs.tenantId, viewConfigs.entityTypeSlug],
              set: {
                listColumns,
                detailLayout,
                formFieldOrder,
                updatedAt: new Date(),
              },
            })
            .returning();

          return { row: updated, isNew: !existing };
        },
      );

      return c.json({ data: row }, isNew ? 201 : 200);
    } catch (err: unknown) {
      logger.error(
        { err, tenantId: auth.tenantId, entityType },
        "patchViewConfig failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

export { router as viewConfigsRouter };
