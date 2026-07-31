import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { listEntityTypes, MAX_PAGE_SIZE } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

const ListEntityTypesQuerySchema = z.object({
  moduleId: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
});

export const listEntityTypesHandler = factory.createHandlers(
  requireAuth(),
  zValidator("query", ListEntityTypesQuerySchema),
  async (c) => {
    const { moduleId, cursor, limit } = c.req.valid("query");
    const { tenantId } = c.get("auth");

    try {
      const page = await withTenantContext(tenantId, (tx) =>
        listEntityTypes(tx, tenantId, { moduleId, cursor, limit }),
      );
      return c.json(page);
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
