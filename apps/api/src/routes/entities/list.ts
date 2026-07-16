import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { listEntities, MAX_PAGE_SIZE } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

const ListEntitiesQuerySchema = z.object({
  entityTypeId: z.string().uuid(),
  state: z.string().optional(),
  assignedTo: z.string().optional(),
  fields: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(v);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "fields must be valid JSON",
        });
        return z.NEVER;
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "fields must be a JSON object",
        });
        return z.NEVER;
      }
      return parsed as Record<string, unknown>;
    }),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  cursor: z.string().optional(),
  includeDeleted: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  rootOnly: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

export const listEntitiesHandler = factory.createHandlers(
  requireAuth(),
  zValidator("query", ListEntitiesQuerySchema),
  async (c) => {
    const { tenantId, userId, roles } = c.get("auth");
    const query = c.req.valid("query");

    const isPrivileged = roles.includes("admin") || roles.includes("agent");

    try {
      const { fields, ...rest } = query;
      // Non-privileged users are always scoped to their own records — query param cannot override
      const assignedTo = isPrivileged ? rest.assignedTo : userId;
      const page = await withTenantContext(tenantId, (tx) =>
        listEntities(tx, tenantId, {
          ...rest,
          assignedTo,
          fieldFilters: fields,
          rootOnly: rest.rootOnly,
        }),
      );
      return c.json({ data: page.data, nextCursor: page.nextCursor });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
