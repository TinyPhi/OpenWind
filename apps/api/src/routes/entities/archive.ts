import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { archiveEntity } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

const ArchiveQuerySchema = z.object({
  confirm: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

export const archiveEntityHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent"),
  zValidator("query", ArchiveQuerySchema),
  async (c) => {
    const instanceId = c.req.param("id") ?? "";
    const { confirm } = c.req.valid("query");
    const { tenantId } = c.get("auth");

    try {
      const result = await withTenantContext(tenantId, (tx) =>
        archiveEntity(tx, tenantId, instanceId, confirm),
      );
      return c.json({ data: result });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
