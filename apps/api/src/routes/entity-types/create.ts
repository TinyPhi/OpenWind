import { zValidator } from "../../lib/validator.js";
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

// Intentionally open to every authenticated role, unlike update.ts/delete.ts
// (admin-only): this is step 1 of the self-service "any user can create their
// own workflow" flow (docs/specs/workflow-ownership-admin.md, R4/R1) — the
// admin-ui calls this before POST /workflows for every role. Do not tighten
// to admin-only; that breaks workflow creation for non-admin users.
export const createEntityTypeHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
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
