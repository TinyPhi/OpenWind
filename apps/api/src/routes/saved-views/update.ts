import { zValidator } from "../../lib/validator.js";
import { requireAuth } from "@platform/auth";
import { withTenantAndUserContext, savedViews } from "@platform/db";
import { eq, and } from "drizzle-orm";
import { factory } from "./factory.js";
import { UpdateSavedViewSchema } from "./schemas.js";

export const updateSavedViewHandler = factory.createHandlers(
  requireAuth(),
  zValidator("json", UpdateSavedViewSchema),
  async (c) => {
    const { tenantId, userId } = c.get("auth");
    const id = c.req.param("id") ?? "";
    const input = c.req.valid("json");

    const row = await withTenantAndUserContext(tenantId, userId, async (tx) => {
      // If setting as default, clear other defaults first
      if (input.isDefault) {
        await tx
          .update(savedViews)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(
            and(
              eq(savedViews.tenantId, tenantId),
              eq(savedViews.userId, userId),
              eq(savedViews.isDefault, true),
            ),
          );
      }

      const [updated] = await tx
        .update(savedViews)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.filterConfig !== undefined && {
            filterConfig: input.filterConfig,
          }),
          ...(input.sortConfig !== undefined && {
            sortConfig: input.sortConfig,
          }),
          ...(input.isDefault !== undefined && { isDefault: input.isDefault }),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(savedViews.id, id),
            eq(savedViews.tenantId, tenantId),
            eq(savedViews.userId, userId),
          ),
        )
        .returning();

      return updated;
    });

    if (!row) {
      return c.json(
        { error: "NOT_FOUND", message: "Saved view not found" },
        404,
      );
    }

    return c.json({ data: row });
  },
);
