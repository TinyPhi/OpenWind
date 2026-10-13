import { z } from "zod";
import { zValidator } from "../../lib/validator.js";
import { requirePlatformAdmin } from "@platform/auth";
import {
  tenants,
  withPlatformAdminContext,
  toPlatformAdminSandboxView,
} from "@platform/db";
import { desc, eq, and } from "drizzle-orm";
import { platformAdminFactory } from "./factory.js";

/**
 * T17 (docs/specs/multi-org-sandbox.md) -- backend prerequisite for the platform-admin
 * dashboard's list/detail views. `toPlatformAdminSandboxView` (T19) already existed but had
 * no route reading through it until now -- see that function's own doc comment for why its
 * output shape is the only thing platform_admin-reachable routes may ever return (R2, no
 * business data). Both handlers select only the columns platform_admin_role is actually
 * granted (migration 0135): id, name, isSandbox, trialEndsAt, createdAt.
 */
const SANDBOX_VIEW_COLUMNS = {
  id: tenants.id,
  name: tenants.name,
  isSandbox: tenants.isSandbox,
  trialEndsAt: tenants.trialEndsAt,
  createdAt: tenants.createdAt,
};

export const sandboxListHandler = platformAdminFactory.createHandlers(
  requirePlatformAdmin(),
  async (c) => {
    const rows = await withPlatformAdminContext((tx) =>
      tx
        .select(SANDBOX_VIEW_COLUMNS)
        .from(tenants)
        .where(eq(tenants.isSandbox, true))
        .orderBy(desc(tenants.createdAt)),
    );

    return c.json({ data: rows.map(toPlatformAdminSandboxView) });
  },
);

const TenantIdParamSchema = z.object({ tenantId: z.string().uuid() });

export const sandboxDetailHandler = platformAdminFactory.createHandlers(
  requirePlatformAdmin(),
  zValidator("param", TenantIdParamSchema),
  async (c) => {
    const { tenantId } = c.req.valid("param");

    const [row] = await withPlatformAdminContext((tx) =>
      tx
        .select(SANDBOX_VIEW_COLUMNS)
        .from(tenants)
        .where(and(eq(tenants.id, tenantId), eq(tenants.isSandbox, true)))
        .limit(1),
    );

    // 404, not 403, for both "no such tenant" and "not a sandbox" (security.md
    // 404-not-403 rule — a platform_admin has no narrower resource to be denied here).
    if (!row) {
      return c.json({ error: "NOT_FOUND", message: "No such sandbox" }, 404);
    }

    return c.json({ data: toPlatformAdminSandboxView(row) });
  },
);
