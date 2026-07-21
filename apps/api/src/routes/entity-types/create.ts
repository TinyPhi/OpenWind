import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { createEntityType } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

const CreateEntityTypeSchema = z.object({
  name: z.string().min(1).max(100),
  plural: z.string().min(1).max(100),
  icon: z.string().optional(),
  moduleId: z.string().uuid().optional(),
  allowCustomFields: z.boolean().default(true),
});

export const createEntityTypeHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  zValidator("json", CreateEntityTypeSchema),
  async (c) => {
    const input = c.req.valid("json");
    const { tenantId } = c.get("auth");

    try {
      const entityType = await withTenantContext(tenantId, (tx) =>
        createEntityType(tx, tenantId, input),
      );
      return c.json({ data: entityType }, 201);
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
