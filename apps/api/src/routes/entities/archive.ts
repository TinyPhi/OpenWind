import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { archiveEntity } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import {
  cancelAllPendingAlertsForInstance,
  collectActiveDescendantIds,
} from "../../lib/cascade-cancel-alerts.js";

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
      // Computed BEFORE archiving — archiveEntity() soft-deletes the parent_of
      // relations themselves as part of the cascade, so this same query run
      // afterward would find nothing (see collectActiveDescendantIds's doc).
      const descendantIds = await collectActiveDescendantIds(
        tenantId,
        instanceId,
      );

      const result = await withTenantContext(tenantId, (tx) =>
        archiveEntity(tx, tenantId, instanceId, confirm),
      );

      // Only cascade-cancel when the archive actually happened — the
      // requiresConfirm branch archives nothing (it's just the "this has N
      // active children, pass ?confirm=true" prompt), so cancelling alerts
      // on that path would wrongly cancel reminders on tickets that are
      // still fully active.
      if ("archived" in result) {
        void cancelAllPendingAlertsForInstance(tenantId, instanceId);
        for (const descendantId of descendantIds) {
          void cancelAllPendingAlertsForInstance(tenantId, descendantId);
        }
      }

      return c.json({ data: result });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
