import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import {
  getEntity,
  listChildInstances,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import {
  batchLookupApplicationNames,
  toOriginDisplay,
} from "../../lib/resolve-origin-display.js";
// Uses the same hasEntityReadAccess gate get.ts applies to this exact parent
// record — not canUserReadInstance (which lacks createdBy/__accessUsers ACL
// checks and would be stricter than get.ts's own gate on the parent).
import { hasEntityReadAccess } from "../../lib/entity-access.js";

const ListChildrenQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
});

export const listChildrenHandler = factory.createHandlers(
  requireAuth(),
  zValidator("query", ListChildrenQuerySchema),
  async (c) => {
    const parentId = c.req.param("id") ?? "";
    const query = c.req.valid("query");
    const { tenantId, userId, roles } = c.get("auth");

    try {
      const parent = await withTenantContext(tenantId, (tx) =>
        getEntity(tx, tenantId, parentId),
      );

      if (!hasEntityReadAccess(parent, userId, roles)) {
        return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
      }

      const page = await withTenantContext(tenantId, (tx) =>
        listChildInstances(tx, tenantId, parentId, {
          ...(query.cursor !== undefined && { cursor: query.cursor }),
          limit: query.limit,
        }),
      );
      // docs/specs/third-party-api-origin-tagging.md R4 -- sub-tickets get
      // their own independent tag, same live-resolution as the parent list.
      const nameByClientId = await batchLookupApplicationNames(page.data);
      const data = page.data.map((row) => ({
        ...row,
        origin: toOriginDisplay(row, nameByClientId),
      }));

      return c.json({ data, nextCursor: page.nextCursor });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
