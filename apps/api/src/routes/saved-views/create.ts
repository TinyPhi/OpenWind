import { zValidator } from "../../lib/validator.js";
import { requireAuth } from "@platform/auth";
import { withTenantAndUserContext, savedViews } from "@platform/db";
import { eq, and, count } from "drizzle-orm";
import { factory } from "./factory.js";
import { CreateSavedViewSchema } from "./schemas.js";

const MAX_VIEWS_PER_USER_PER_TYPE = 20;

export const createSavedViewHandler = factory.createHandlers(
  requireAuth(),
  zValidator("json", CreateSavedViewSchema),
  async (c) => {
    const { tenantId, userId } = c.get("auth");
    const input = c.req.valid("json");

    const result = await withTenantAndUserContext(
      tenantId,
      userId,
      async (tx) => {
        // Enforce max-20 limit
        const [countRow] = await tx
          .select({ value: count() })
          .from(savedViews)
          .where(
            and(
              eq(savedViews.tenantId, tenantId),
              eq(savedViews.userId, userId),
              eq(savedViews.entityTypeId, input.entityTypeId),
            ),
          );

        if ((countRow?.value ?? 0) >= MAX_VIEWS_PER_USER_PER_TYPE) {
          return { limitReached: true } as const;
        }

        // If setting as default, clear existing defaults for this user+entityType
        if (input.isDefault) {
          await tx
            .update(savedViews)
            .set({ isDefault: false, updatedAt: new Date() })
            .where(
              and(
                eq(savedViews.tenantId, tenantId),
                eq(savedViews.userId, userId),
                eq(savedViews.entityTypeId, input.entityTypeId),
                eq(savedViews.isDefault, true),
              ),
            );
        }

        const [row] = await tx
          .insert(savedViews)
          .values({
            tenantId,
            userId, // always from auth — never from body
            entityTypeId: input.entityTypeId,
            name: input.name,
            filterConfig: input.filterConfig,
            sortConfig: input.sortConfig,
            isDefault: input.isDefault,
          })
          .returning();

        return { row } as const;
      },
    );

    if (result.limitReached) {
      return c.json(
        {
          error: "SAVED_VIEW_LIMIT_REACHED",
          message: `Maximum ${MAX_VIEWS_PER_USER_PER_TYPE} saved views per entity type`,
        },
        409,
      );
    }

    return c.json({ data: result.row }, 201);
  },
);
