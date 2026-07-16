import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { createRelation } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

const CreateRelationSchema = z.object({
  toInstanceId: z.string().uuid(),
  relationType: z.string().min(1).max(100),
});

export const createRelationHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent"),
  zValidator("json", CreateRelationSchema),
  async (c) => {
    const fromInstanceId = c.req.param("id") ?? "";
    const input = c.req.valid("json");
    const { tenantId } = c.get("auth");

    try {
      const relation = await withTenantContext(tenantId, (tx) =>
        createRelation(tx, tenantId, {
          fromInstanceId,
          toInstanceId: input.toInstanceId,
          relationType: input.relationType,
        }),
      );
      return c.json({ data: relation }, 201);
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
